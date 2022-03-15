import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { SUBSCRIPTION_STATUS, COLLECTIONS, REGION } from './constant';
import { Notification } from './interfaces';
import { logger } from 'firebase-functions';
import Stripe from 'stripe';
import config from './config';

const apiVersion = '2020-08-27';
const stripe = new Stripe(config.stripeSecretKey, { apiVersion });

admin.initializeApp();

/*
    This function will invoke when subscription document get updated. In this function we are doing following action.

    if subscription status is active
        1. Adding activePlan into users collections
        2. Adding notification data to users/notifications collection
        3. Adding buyer customer reference to products/customers collection
        4. Incrementing number_of_customers count in products collection

    if subsciption status other than active
        1. Removing activePlan into users collections
        2. Removing customer reference from products/customers collection
        3. Decrementing number_of_customers count in products collection

*/
// export const manageSubScriptionUpdation = functions.region(REGION).firestore.document(`${COLLECTIONS.USER}/{userId}/${COLLECTIONS.SUBSCRIPTION}/{subscriptionId}`)
//     .onUpdate(async (snap, context) => {

//         logger.log(`params: ${JSON.stringify(context.params)}`);

//         const db = getFirestore();
//         let subscription = snap.after.data();
//         let productId = subscription.product.id;
//         productId = productId.substr(productId.lastIndexOf('/') + 1, productId.length);

//         logger.log(`Updating activePlans, customer, notification and customer# for product ${productId}`);

//         if (subscription.status != SUBSCRIPTION_STATUS.ACTIVE) {
//             return Promise.all([
//                 db.collection(COLLECTIONS.USER).doc(context.params.userId).update({ activePlans: FieldValue.arrayRemove(productId) }),
//                 db.collection(COLLECTIONS.PRODUCT).doc(productId).collection("customers").doc(context.params.userId).delete(), // Deleting customer in products
//                 db.collection(COLLECTIONS.PRODUCT).doc(productId).update({ number_of_customers: FieldValue.increment(-1) }) // Increment customer count
//             ])
//         }
//         else if (subscription.status != snap.before.data().status && subscription.status == SUBSCRIPTION_STATUS.ACTIVE) {

//             const userRef = db.collection(COLLECTIONS.USER).doc(context.params.userId);
//             const user = (await userRef.get()).data();

//             let notification: Notification = {
//                 customerId: user.stripeId || '',
//                 firebaseUid: context.params.userId,
//                 productId,
//                 timestamp: Timestamp.now()
//             }

//             return Promise.all([
//                 userRef.collection(COLLECTIONS.NOTIFICATION).doc().set(notification), // Creating Notification Data
//                 db.collection(COLLECTIONS.USER).doc(context.params.userId).update({ activePlans: FieldValue.arrayUnion(productId) }),
//                 db.collection(COLLECTIONS.PRODUCT).doc(productId).collection("customers").doc(context.params.userId).set({ customer: db.doc(`/${COLLECTIONS.USER}/${context.params.userId}`) }), // Adding customer in products
//                 db.collection(COLLECTIONS.PRODUCT).doc(productId).update({ number_of_customers: FieldValue.increment(1) }) // Increment customer count
//             ])
//         }
//         return null;
//     });

/*
    This function will invoke when customers/subscriptions/invoices document get created. In this function we are doing following action.
    1. Incrementing total amount of subscription into products collection
*/
// export const manageInvoiceUpdation = functions.region(REGION).firestore.document(`${COLLECTIONS.USER}/{userId}/${COLLECTIONS.SUBSCRIPTION}/{subscriptionId}/${COLLECTIONS.INVOICE}/{invoiceId}`)
//     .onUpdate(async (snap, context) => {

//         logger.log(`params: ${context.params}`);
//         const db = getFirestore();
//         // Grab the current value of what was written to Firestore.
//         let invoice = snap.after.data();
//         if (!invoice.paid) return null;
//         let subscription = (await db.collection(COLLECTIONS.USER).doc(context.params.userId).collection(COLLECTIONS.SUBSCRIPTION).doc(context.params.subscriptionId).get()).data();
//         let productId = subscription.product.id;
//         productId = productId.substr(productId.lastIndexOf('/') + 1, productId.length);

//         logger.log(`Updating amount: ${invoice.total} for product ${productId}`);

//         return db.collection(COLLECTIONS.PRODUCT).doc(productId).update({ sales_in_usd: FieldValue.increment(invoice.total / 100) })
//     });

const manageSubscriptionStatusChange = async (subscriptionId: string, customerId: string): Promise<void> => {

    const customersSnap = await admin.firestore().collection(COLLECTIONS.USER).where('stripeId', '==', customerId).get();
    if (customersSnap.size !== 1) {
        throw new Error('User not found!');
    }
    const uid = customersSnap.docs[0].id;

    logger.log(`subscriptionId: ${subscriptionId}, customerId: ${customerId} uid: ${uid}`);

    // Retrieve latest subscription status and write it to the Firestore
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['default_payment_method', 'items.data.price.product'],
    });

    const product: Stripe.Product = subscription.items.data[0].price.product as Stripe.Product;

    const db = getFirestore();

    logger.log(`subscription status: ${subscription.status}`);

    logger.log(`Product id: ${product.id}`);

    if (subscription.status == SUBSCRIPTION_STATUS.ACTIVE) {
        const userRef = db.collection(COLLECTIONS.USER).doc(uid);
        const user = (await userRef.get()).data();

        let notification: Notification = {
            customerId: user.stripeId || '',
            firebaseUid: uid,
            productId: product.id,
            timestamp: Timestamp.now()
        }

        await Promise.all([
            userRef.collection(COLLECTIONS.NOTIFICATION).doc().set(notification), // Creating Notification Data
            db.collection(COLLECTIONS.USER).doc(uid).update({ activePlans: FieldValue.arrayUnion(product.id) }),
            db.collection(COLLECTIONS.PRODUCT).doc(product.id).collection("customers").doc(uid).set({ customer: db.doc(`/${COLLECTIONS.USER}/${uid}`) }), // Adding customer in products
            db.collection(COLLECTIONS.PRODUCT).doc(product.id).update({ number_of_customers: FieldValue.increment(1) }) // Increment customer count
        ])

        logger.log(`Successfully updated data for product id: ${product.id}, user id: ${uid}`);
    }
    else if (subscription.status == SUBSCRIPTION_STATUS.CANCELED) {
        await Promise.all([
            db.collection(COLLECTIONS.USER).doc(uid).update({ activePlans: FieldValue.arrayRemove(product.id) }),
            db.collection(COLLECTIONS.PRODUCT).doc(product.id).collection("customers").doc(uid).delete(), // Deleting customer in products
            db.collection(COLLECTIONS.PRODUCT).doc(product.id).update({ number_of_customers: FieldValue.increment(-1) }) // Increment customer count
        ])

        logger.log(`Successfully updated data for product id: ${product.id}, user id: ${uid}`);
    }
}

const manageInvoiceUpdation = async (invoice: Stripe.Invoice) => {
    logger.log(`params: ${JSON.stringify(invoice)}`);
    const db = getFirestore();
    
    if (!invoice.paid) return null;

    const customersSnap = await admin.firestore().collection(COLLECTIONS.USER).where('stripeId', '==', invoice.customer).get();
    if (customersSnap.size !== 1) {
        throw new Error('User not found!');
    }
    
    let productId = invoice.lines.data[0].price.product.toString();

    logger.log(`Updating amount: ${invoice.total} for product ${productId}`);

    await db.collection(COLLECTIONS.PRODUCT).doc(productId).update({ sales_in_usd: FieldValue.increment(invoice.total / 100) })
}

/**
 * A webhook handler function for the relevant Stripe events.
 */
export const subscriptionUpdateWebhook = functions.region(REGION).runWith({ secrets: ["STRIPE_API_KEY", "STRIPE_SUBSCRIPTION_WEBHOOK_SECRET"] }).https.onRequest(
    async (req: functions.https.Request, resp) => {
        const relevantEvents = new Set([
            'customer.subscription.updated',
            'customer.subscription.deleted',
            'invoice.paid'
        ]);
        let event: Stripe.Event;
        
        try {
            event = stripe.webhooks.constructEvent(
                req.rawBody,
                req.headers['stripe-signature'],
                config.stripeWebhookSecret
            );
        } catch (error) {
            resp.status(401).send('Webhook Error: Invalid Secret');
            return;
        }

        if (relevantEvents.has(event.type)) {
            try {
                switch (event.type) {
                    case 'customer.subscription.updated':
                    case 'customer.subscription.deleted':
                        const subscription = event.data.object as Stripe.Subscription;
                        await manageSubscriptionStatusChange(
                            subscription.id,
                            subscription.customer as string
                        );
                        break;
                    case 'invoice.paid':
                        const invoice = event.data.object as Stripe.Invoice;
                        await manageInvoiceUpdation(invoice);
                        break;
                    default:
                    //   logs.webhookHandlerError(
                    //     new Error('Unhandled relevant event!'),
                    //     event.id,
                    //     event.type
                    //   );
                }
                //logs.webhookHandlerSucceeded(event.id, event.type);
            } catch (error) {
                //logs.webhookHandlerError(error, event.id, event.type);
                resp.json({
                    error: 'Webhook handler failed. View function logs in Firebase.',
                });
                return;
            }
        }

        // Return a response to Stripe to acknowledge receipt of the event.
        console.log(config.stripeSecretKey);
        resp.json({ received: true });
    }
);