/**
 * Henry's Fork Plaza Portal — backend automations.
 *
 * Replaces two GoHighLevel workflows that the site used to depend on:
 *   1. "Update Notifications" — emailed the managers/owners whenever a
 *      member requested access, an account was approved, a discussion post
 *      or reply went up, or a poll went live. Previously fired via a
 *      client-side POST to a GHL webhook URL.
 *   2. "Stripe Analytics Automation" — kept `subscriptionStatus` on each
 *      member's Firestore user doc in sync with their Stripe subscription.
 *
 * Both are now handled here, server-side, with no dependency on GHL.
 * Notifications fire directly off Firestore writes (Cloud Functions
 * triggers), and Stripe talks straight to this Cloud Function instead of
 * to a GHL-hosted webhook.
 */

const {onDocumentCreated, onDocumentUpdated} = require("firebase-functions/v2/firestore");
const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const {Resend} = require("resend");
const Stripe = require("stripe");
const logger = require("firebase-functions/logger");

initializeApp();
const db = getFirestore();

// Set these with `firebase functions:secrets:set <NAME>` — see DEPLOY.md.
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

// Who gets the "Internal Notification" emails. Update this list any time —
// no redeploy needed for anything else, just edit and redeploy this file.
const NOTIFY_EMAILS = [
  "parker@wingmen.marketing",
  "destinlthayne@gmail.com",
  "fuhriman79@yahoo.com",
];

// Must be an address on a domain you've verified in Resend (see DEPLOY.md).
const FROM_EMAIL = "Henry's Fork Plaza Portal <notifications@henrysforkplaza.com>";

/**
 * Sends one notification email to the full NOTIFY_EMAILS list.
 */
async function sendNotification(apiKey, subject, html) {
  const resend = new Resend(apiKey);
  const {error} = await resend.emails.send({
    from: FROM_EMAIL,
    to: NOTIFY_EMAILS,
    subject,
    html,
  });
  if (error) {
    logger.error("Resend send failed", error);
    throw new Error(error.message || "Failed to send notification email");
  }
}

function escapeHtml(str) {
  return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------
// 1. New account request (signup, pending approval)
// ---------------------------------------------------------------------
exports.onNewUser = onDocumentCreated(
    {document: "users/{email}", secrets: [RESEND_API_KEY]},
    async (event) => {
      const data = event.data.data();
      if (!data || data.isApproved) return; // ignore pre-approved/admin-seeded docs

      await sendNotification(
          RESEND_API_KEY.value(),
          `New account request: ${data.businessName || data.name || "New member"}`,
          `<p><strong>${escapeHtml(data.name)}</strong> (${escapeHtml(data.businessName)}) requested access to the Henry's Fork Plaza portal.</p>
       <p>Email: ${escapeHtml(data.email)}</p>
       <p>Approve or reject from the Admin panel on the site.</p>`,
      );
    },
);

// ---------------------------------------------------------------------
// 2. Account approved
// ---------------------------------------------------------------------
exports.onUserApproved = onDocumentUpdated(
    {document: "users/{email}", secrets: [RESEND_API_KEY]},
    async (event) => {
      const before = event.data.before.data();
      const after = event.data.after.data();
      if (before.isApproved || !after.isApproved) return;

      await sendNotification(
          RESEND_API_KEY.value(),
          `Account approved: ${after.businessName || after.name}`,
          `<p><strong>${escapeHtml(after.name)}</strong> (${escapeHtml(after.businessName)}) was approved for portal access.</p>`,
      );
    },
);

// ---------------------------------------------------------------------
// 3. New discussion post (auto-live for admins, pending review otherwise)
// ---------------------------------------------------------------------
exports.onNewDiscussion = onDocumentCreated(
    {document: "discussions/{postId}", secrets: [RESEND_API_KEY]},
    async (event) => {
      const data = event.data.data();
      if (!data) return;
      const isLive = !!data.isApproved;

      await sendNotification(
          RESEND_API_KEY.value(),
          `${isLive ? "New discussion posted" : "Discussion awaiting approval"}: ${data.title}`,
          `<p><strong>${escapeHtml(data.businessName)}</strong> ${isLive ? "posted" : "submitted"} a new topic: <strong>${escapeHtml(data.title)}</strong></p>
       <p>${escapeHtml(data.content)}</p>
       ${isLive ? "" : "<p>Review it in the Admin panel.</p>"}`,
      );
    },
);

// ---------------------------------------------------------------------
// 4. New reply on a discussion (replies live as an array field on the post)
// ---------------------------------------------------------------------
exports.onNewReply = onDocumentUpdated(
    {document: "discussions/{postId}", secrets: [RESEND_API_KEY]},
    async (event) => {
      const beforeData = event.data.before.data() || {};
      const afterData = event.data.after.data() || {};
      const before = beforeData.replies || [];
      const after = afterData.replies || [];
      if (after.length <= before.length) return;

      const beforeIds = new Set(before.map((r) => r.id));
      const newReplies = after.filter((r) => !beforeIds.has(r.id));

      for (const reply of newReplies) {
        await sendNotification(
            RESEND_API_KEY.value(),
            `New reply on: ${afterData.title}`,
            `<p><strong>${escapeHtml(reply.businessName)}</strong> replied to <strong>${escapeHtml(afterData.title)}</strong>:</p>
         <p>${escapeHtml(reply.text)}</p>`,
        );
      }
    },
);

// ---------------------------------------------------------------------
// 5. New poll created
// ---------------------------------------------------------------------
exports.onNewPoll = onDocumentCreated(
    {document: "polls/{pollId}", secrets: [RESEND_API_KEY]},
    async (event) => {
      const data = event.data.data();
      if (!data) return;

      await sendNotification(
          RESEND_API_KEY.value(),
          `New poll live: ${data.question}`,
          `<p>A new member poll is live: <strong>${escapeHtml(data.question)}</strong></p>
       <p>Options: ${escapeHtml(Object.keys(data.options || {}).join(", "))}</p>`,
      );
    },
);

// ---------------------------------------------------------------------
// 6. Stripe webhook — keeps subscriptionStatus in sync in Firestore.
//    Point Stripe's webhook endpoint at this function's URL after deploy
//    (printed at the end of `firebase deploy`), instead of at GHL.
// ---------------------------------------------------------------------
exports.stripeWebhook = onRequest(
    {secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET], cors: false},
    async (req, res) => {
      const stripe = new Stripe(STRIPE_SECRET_KEY.value());
      let event;

      try {
        event = stripe.webhooks.constructEvent(
            req.rawBody,
            req.headers["stripe-signature"],
            STRIPE_WEBHOOK_SECRET.value(),
        );
      } catch (err) {
        logger.error("Stripe signature verification failed", err.message);
        res.status(400).send(`Webhook Error: ${err.message}`);
        return;
      }

      try {
        switch (event.type) {
          case "checkout.session.completed": {
            const session = event.data.object;
            const email = (session.customer_details && session.customer_details.email || "")
                .toLowerCase();
            if (email) {
              await db.collection("users").doc(email).set(
                  {subscriptionStatus: "active", stripeCustomerId: session.customer},
                  {merge: true},
              );
              logger.info(`Marked ${email} active after checkout`);
            }
            break;
          }
          case "customer.subscription.updated":
          case "customer.subscription.deleted": {
            const sub = event.data.object;
            const status = (sub.status === "active" || sub.status === "trialing") ?
              "active" : "inactive";
            const matches = await db.collection("users")
                .where("stripeCustomerId", "==", sub.customer)
                .get();
            const batch = db.batch();
            matches.forEach((doc) => batch.update(doc.ref, {subscriptionStatus: status}));
            await batch.commit();
            logger.info(`Updated ${matches.size} user(s) to ${status} for customer ${sub.customer}`);
            break;
          }
          default:
            // Ignore other event types.
            break;
        }
        res.status(200).send("ok");
      } catch (err) {
        logger.error("Error handling Stripe webhook", err);
        res.status(500).send("Internal error");
      }
    },
);
