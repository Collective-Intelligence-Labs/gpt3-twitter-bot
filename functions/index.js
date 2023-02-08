const functions = require('firebase-functions');
const admin = require('firebase-admin');
const fs = require("fs");
const path = require('path');
const util = require('util')
const readFileAsync = util.promisify(fs.readFile)
const crypto = require('crypto');


admin.initializeApp();

// Database reference
const dbRef = admin.firestore().doc('tokens/demo');

// Twitter API init
const TwitterApi = require('twitter-api-v2').default;
const twitterClient = new TwitterApi({
  clientId: 'YOUR_CLIENT_ID',
  clientSecret: 'YOUR_CLIENT_SECRET',
});

const callbackURL = 'http://127.0.0.1:5000/gpt3-twitter-bot-bba79/us-central1/callback';

// OpenAI API init
const { Configuration, OpenAIApi } = require('openai');
const configuration = new Configuration({
  organization: 'YOUR_OPENAI_ORG',
  apiKey: 'YOUR_OPENAI_SECRET',
});
const openai = new OpenAIApi(configuration);

// STEP 1 - Auth URL
exports.auth = functions.https.onRequest(async (request, response) => {
  const { url, codeVerifier, state } = twitterClient.generateOAuth2AuthLink(
    callbackURL,
    { scope: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'] }
  );

  // store verifier
  await dbRef.set({ codeVerifier, state });

  response.redirect(url);
});

// STEP 2 - Verify callback code, store access_token 
exports.callback = functions.https.onRequest(async (request, response) => {
  const { state, code } = request.query;

  const dbSnapshot = await dbRef.get();
  const { codeVerifier, state: storedState } = dbSnapshot.data();

  if (state !== storedState) {
    return response.status(400).send('Stored tokens do not match!');
  }

  const {
    client: loggedClient,
    accessToken,
    refreshToken,
  } = await twitterClient.loginWithOAuth2({
    code,
    codeVerifier,
    redirectUri: callbackURL,
  });

  await dbRef.set({ accessToken, refreshToken });

  const { data } = await loggedClient.v2.me(); // start using the client if you want

  response.send(data);
});

// const SAMPLE_TWEET_ID = "1481065155438202880";
// const FAKE_TWEET_ID = "1613636533134757903";

const TEXT_DAVINCI_003 = "text-davinci-003";
const TEXT_DAVINCI_003_MAX_CONTEXT_LEN = 4096;
const OUTPUT_COMMENT_MAX_LEN = 280;

const CONCEPT_BEGINS_LABEL = "[CT_BEGIN]";
const CONCEPT_ENDS_LABEL = "[CT_END]";

const POST_BEGINS_LABEL = "[PT_BEGIN]";
const POST_ENDS_LABEL = "[PT_END]";

const CONCEPT_DETAILS_LINK = "https://docsend.com/view/eqt2iazwmff3jikh";
const LEARN_MORE_TEXT = `See ${CONCEPT_DETAILS_LINK}`; // in case of Twitter, it may be not worthing to insert the link, as a tweet's max length is 280 characters only. To generate a good-to-go response with the 'text-davinci-003' model, you need to specify at least 2048 tokens in the 'max_tokens' param, which will result in a text with approximately 600 characters in length that will need to be digested.


const verifyRequest = (sigHex) => {
  const publicKey = crypto.createPublicKey({ 
    key: Buffer.from('3082010a0282010100cc95154772b51b39f30a11cb903fb23d06ed465b3a0a32b9188f7177e3af9cc9889df3ea4577bd88f4009139022745b3a3a1c2d7d5bbc0bb8124a419d4e12411246138f2462ffc31095aab1355b4fd39240c5208ca5c2139b7e46c95fb66839df21d2fd8a6eded7de9eafcd05e27613aeeed6c5ce7bc1a057492e561273160c65ce532bcf737861c3097a7baa4532b1f2e1444556fe6065b60aa02697896b80eb24274da4b07408b1325e87f0f586b96712531ffd232ff64cb20535041e2a0ddd369fe689e92182e75f3565db73cbb2986030e350289df695397bce08d364d6ee2e695c8ce149d22742940fafbd65dacb1676a49837060fea1ccf6932fc177bf0203010001', 'hex'), 
    type: 'pkcs1', 
    format: 'der' 
  });
  const signature = Buffer.from(sigHex, 'hex');
  const signedData = Buffer.from("just_a_secret_key");
  const isVerified = crypto.verify("SHA256", signedData, publicKey, signature);
  return isVerified;
}

// STEP 3 - Upload concept
exports.concept = functions.https.onRequest(async (request, response) => {
  try {

    const sigHex = request.query.sigHex;
    if (!sigHex) {
      throw Error(`The 'sigHex' query parameter must be specified`);
    }

    const isVerified = verifyRequest(sigHex);
    if (!isVerified) {
      throw Error(`Request from an unauthorized party`);
    }

    const DIALOG_RULES_PROMPT = `
I want you to process and remeber a text that I will send to you in my next message (refer to it as the concept-message). 
The text will start after the keyword ${CONCEPT_BEGINS_LABEL}, and end before the keyword ${CONCEPT_ENDS_LABEL}. 
After that, I will start to send you messages in a queue (refer to them as post-messages). 
Each post-message will contain a text that will start after the keyword ${POST_BEGINS_LABEL}, and end before the keyword ${POST_ENDS_LABEL}. 
I want you to generate a response for each post-message that would be relevant to the concept-message and explain how the idea described in the concept-message could help to achieve the goals described in the post-message you are responding to. 
There are a few more requirements for the generating response that you need to fulfill. 
At the first, the response must contain this HTML link - ${CONCEPT_DETAILS_LINK} and propose to learn more about the idea described in the concept-message. 
At the second, the total length of text in the generated response must not exceed ${OUTPUT_COMMENT_MAX_LEN} characters`;

    const rulesRes = await openai.createCompletion(TEXT_DAVINCI_003, {
      prompt: DIALOG_RULES_PROMPT,
      max_tokens: TEXT_DAVINCI_003_MAX_CONTEXT_LEN / 4, // the prompt will need more tokens to address all requirements
    });
    const rulesResText = rulesRes.data.choices[0].text.trim();
    console.log("Dialog set:", rulesResText);

    const COMPLETE_WEB3_ARCHITECTURE_DIGEST = await readFileAsync(
      path.resolve('./complete_web3_architecture_digest.txt')
    );
    const CONCEPT_PROMPT = `${CONCEPT_BEGINS_LABEL}${COMPLETE_WEB3_ARCHITECTURE_DIGEST}${CONCEPT_ENDS_LABEL}`;
    const conceptRes = await openai.createCompletion(TEXT_DAVINCI_003, {
      prompt: CONCEPT_PROMPT,
      max_tokens: TEXT_DAVINCI_003_MAX_CONTEXT_LEN / 2,
    });
    const conceptResText = conceptRes.data.choices[0].text.trim();
    console.log("Concept uploaded", conceptResText);

    response.status(400).send({ rulesResText, conceptResText });

  }

  catch(err) {
    console.error("An error occurred while commenting a post: ", err);
    response.status(400).send({ err: err.message });
  }

});



// STEP 4 - Comment to a tweet
exports.comment = functions.https.onRequest(async (request, response) => {
  try {

    const sigHex = request.query.sigHex;
    if (!sigHex) {
      throw Error(`The 'sigHex' query parameter must be specified`);
    }

    const isVerified = verifyRequest(sigHex);
    if (!isVerified) {
      throw Error(`Request from an unauthorized party`);
    }
    
    const tweetId = request.query.tweetId;
    if (!tweetId) {
      throw Error(`The 'tweetId' query parameter must be specified`);
    }

    const { refreshToken } = (await dbRef.get()).data();
    const {
      client: refreshedClient,
      accessToken,
      refreshToken: newRefreshToken,
    } = await twitterClient.refreshOAuth2Token(refreshToken);

    await dbRef.set({ accessToken, refreshToken: newRefreshToken });

    const tweet = await refreshedClient.v2.singleTweet(
      tweetId
    );

    if (!tweet) {
      throw Error(`Tweet ${tweetId} is not found`);
    }

    const INPUT_POST_TEXT = `${tweet.data.text.trim()}`;

    const POST_PROMPT = `${POST_BEGINS_LABEL}${INPUT_POST_TEXT}${POST_ENDS_LABEL}`;
    const commentRes = await openai.createCompletion(TEXT_DAVINCI_003, {
      prompt: POST_PROMPT,
      max_tokens: TEXT_DAVINCI_003_MAX_CONTEXT_LEN / 2
    });
    const commentResText = commentRes.data.choices[0].text.trim();
    const FULL_COMMENT_TEXT = `${commentResText}`;
    console.log("Comment generated:", FULL_COMMENT_TEXT);

    const LEARN_MORE_NOTE = `${' ' + LEARN_MORE_TEXT}`;

    const OUTPUT_COMMENT_TEXT = `${FULL_COMMENT_TEXT}${FULL_COMMENT_TEXT.includes(CONCEPT_DETAILS_LINK) ? '' : LEARN_MORE_NOTE}`;

    if (OUTPUT_COMMENT_TEXT.length <= OUTPUT_COMMENT_MAX_LEN) {

      console.log("Output comment:", OUTPUT_COMMENT_TEXT);
      const { data } = await refreshedClient.v2.reply(
        OUTPUT_COMMENT_TEXT,
        tweetId
      );
      response.send({ data });

    } else {

      const FULL_COMMENT_DIGEST_PROMPT = `I want you to make a digest that will be no more than ${OUTPUT_COMMENT_MAX_LEN - LEARN_MORE_NOTE.length} characters in length based on the following text: "${FULL_COMMENT_TEXT}"`;
      const commentDigestRes = await openai.createCompletion(TEXT_DAVINCI_003, {
        prompt: FULL_COMMENT_DIGEST_PROMPT,
        max_tokens: 2600 // has to be defined in experimentally
      });
      const commentDigestResText = commentDigestRes.data.choices[0].text.trim();
      const DIGESTED_COMMENT_TEXT = `${commentDigestResText}`;
      console.log("Comment digested:", DIGESTED_COMMENT_TEXT);
  
      const OUTPUT_COMMENT_TEXT = `${DIGESTED_COMMENT_TEXT}${LEARN_MORE_NOTE}`;

      console.log("Output comment:", OUTPUT_COMMENT_TEXT);
      const { data } = await refreshedClient.v2.reply(
        OUTPUT_COMMENT_TEXT,
        tweetId
      );
      response.send({ data });
    }

  }

  catch(err) {
    console.error("An error occurred while commenting a post: ", err);
    response.status(400).send({ err: err.message });
  }

});