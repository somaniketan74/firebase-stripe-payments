import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { SUBSCRIPTION_STATUS, COLLECTIONS, REGION } from './constant'; 
import { Notification } from './interfaces';
import { logger } from 'firebase-functions';

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
export const manageSubScriptionUpdation = functions.region(REGION).firestore.document(`${COLLECTIONS.USER}/{userId}/${COLLECTIONS.SUBSCRIPTION}/{subscriptionId}`)
    .onUpdate(async (snap, context) => {

        logger.log(`params: ${JSON.stringify(context.params)}`);
        
        const db = getFirestore();
        let subscription = snap.after.data();
        let productId = subscription.product.id;
        productId = productId.substr(productId.lastIndexOf('/') + 1, productId.length);
        
        logger.log(`Updating activePlans, customer, notification and customer# for product ${productId}`);
        
        if(subscription.status != SUBSCRIPTION_STATUS.ACTIVE){
            return Promise.all([
                db.collection(COLLECTIONS.USER).doc(context.params.userId).update({ activePlans: FieldValue.arrayRemove(productId) }),
                db.collection(COLLECTIONS.PRODUCT).doc(productId).collection("customers").doc(context.params.userId).delete(), // Deleting customer in products
                db.collection(COLLECTIONS.PRODUCT).doc(productId).update({ number_of_customers: FieldValue.increment(-1) }) // Increment customer count
            ])
        }
        else if ( subscription.status != snap.before.data().status && subscription.status == SUBSCRIPTION_STATUS.ACTIVE) {
            
            const userRef = db.collection(COLLECTIONS.USER).doc(context.params.userId);
            const user = (await userRef.get()).data();

            let notification: Notification = {
                customerId: user.stripeId || '',
                firebaseUid: context.params.userId,
                productId,
                timestamp: Timestamp.now()
            }

            return Promise.all([
                userRef.collection(COLLECTIONS.NOTIFICATION).doc().set(notification), // Creating Notification Data
                db.collection(COLLECTIONS.USER).doc(context.params.userId).update({ activePlans: FieldValue.arrayUnion(productId) }),
                db.collection(COLLECTIONS.PRODUCT).doc(productId).collection("customers").doc(context.params.userId).set({customer: db.doc(`/${COLLECTIONS.USER}/${context.params.userId}`)}), // Adding customer in products
                db.collection(COLLECTIONS.PRODUCT).doc(productId).update({ number_of_customers: FieldValue.increment(1) }) // Increment customer count
            ])
        }
        return null;
});

/*
    This function will invoke when customers/subscriptions/invoices document get created. In this function we are doing following action.
    1. Incrementing total amount of subscription into products collection
*/
export const manageInvoiceUpdation = functions.region(REGION).firestore.document(`${COLLECTIONS.USER}/{userId}/${COLLECTIONS.SUBSCRIPTION}/{subscriptionId}/${COLLECTIONS.INVOICE}/{invoiceId}`)
    .onUpdate(async (snap, context) => {

        logger.log(`params: ${context.params}`);
        const db = getFirestore();
        // Grab the current value of what was written to Firestore.
        let invoice = snap.after.data();
        if(!invoice.paid) return null;
        let subscription = (await db.collection(COLLECTIONS.USER).doc(context.params.userId).collection(COLLECTIONS.SUBSCRIPTION).doc(context.params.subscriptionId).get()).data();
        let productId = subscription.product.id;
        productId = productId.substr(productId.lastIndexOf('/') + 1, productId.length);

        logger.log(`Updating amount: ${invoice.total} for product ${productId}`);

        return db.collection(COLLECTIONS.PRODUCT).doc(productId).update({ sales_in_usd: FieldValue.increment(invoice.total/100) })
});
