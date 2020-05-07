/**
 * Sample Node app for Zendesk Chat Conversations API
 *
 * BFlynn: This was inspired and is a refactored version
 * of the original chat_conversation_api script found
 * on https://codesandbox.io/s/51rorvmwx
 * See also: https://develop.zendesk.com/hc/en-us/articles/360001331787
 * This is a work-in-progress,is incomplete and has hard coded values.
 * Use it in its current form for sample purposes only.
 *
 * The app will sign you on as a Zendesk Chat agent
 * and will:
 * - Echo back visitor messages
 * - Transfer visitor to an online department when
 *   visitor sent a message that starts with the word
 *   "transfer"
 * - Send a structured message (i.e. quick replies)
 *   when visitor sent a message that starts with
 *   "what ice cream flavor" or "button me"
 * - Invite another agent to the existing channel
 * - Get and console output agent list (enter 'get agents').
 *
 * There are 2 ways to run the app: (1) from your local
 * machine, or (2) using Codesandbox. The
 * former allows you to run the app without needing
 * to setup the Node environment.
 *
 * (1) Using Local Machine
 * - Require Node 8 or above
 * - Install dependencies: `ws` and `superagent` using
 *   npm or yarn
 * - Update `ACCESS_TOKEN` constants with the access
 *   token that you want to use. Refers to
 *   https://developer.zendesk.com/rest_api/docs/chat/auth
 *   for access token generation guide. Make sure
 *   that it has `read`, `write`, and `chat` scrope.
 * - Run the app using `node conversations_api_sample_app.js`
 *
 * (2) Using Codesandbox
 * - Fork the sandbox by clicking the `Fork` button
 * - Update `ACCESS_TOKEN` constants with the access
 *   token that you want to use. Refers to
 *   https://developer.zendesk.com/rest_api/docs/chat/auth
 *   for access token generation guide. Make sure
 *   that it has `read`, `write`, and `chat` scrope.
 *   ⚠️ WARNING: Your Codesandbox might be public. Please
 *   make sure you did not leave your access token
 *   publicly.
 * - Check the `Terminal` for the process output.
 */
const WebSocket = require('ws')    // https://github.com/websockets/ws
const request = require('superagent')    // https://github.com/visionmedia/superagent

const SubscriptionMessage = require('./graphQLqueries/subscriptionMessage')
const SubscriptionChatActivity = require('./graphQLqueries/subscriptionChatActivity')
const MutationUpdateAgentStatus = require('./graphQLqueries/mutationUpdateAgentStatus')
const MutationSendMessage = require('./graphQLqueries/mutationSendMessage')
const MutationSendQuickReplies = require('./graphQLqueries/mutationSendQuickReplies')
const MutationSendButtonTemplate = require('./graphQLqueries/mutationSendButtonTemplate')
const MutationInviteAgent = require('./graphQLqueries/mutationInviteAgent')
const MutationTransferToDepartment = require('./graphQLqueries/mutationTransferToDepartment')
const QueryDepartments = require('./graphQLqueries/queryDepartments')
const QueryAgents = require('./graphQLqueries/queryAgents')

// Chat Conversation API tokens have a special scope. For details:
// https://developer.zendesk.com/rest_api/docs/chat/conversations-api#authentication
// https://support.zendesk.com/hc/en-us/articles/115010760808
const ACCESS_TOKEN = 'TODO - YOUR_CHAT_CONVERSATION_API_TOKEN_HERE'

const CHAT_API_URL = 'https://chat-api.zopim.com/graphql/request'
const SUBSCRIPTION_DATA_SIGNAL = 'DATA'
const TYPE = {
  VISITOR: 'Visitor'
}

// Globals
let messageSubscriptionId
let chatActivityId
let messageMap = new Map()


async function generateNewAgentSession(access_token) {
  const query = `mutation($access_token: String!) {
        startAgentSession(access_token: $access_token) {
            websocket_url
            session_id
            client_id
        }
    }`
  const variables = { access_token }

  console.log('[startAgentSession] Request sent')

  return await request
    .post(CHAT_API_URL)
    .set({
      "Content-Type": "application/json"
    })
    .send({ query, variables })
}


async function startAgentSession() {
  try {
    const startAgentSessionResp = (await generateNewAgentSession(ACCESS_TOKEN)).body

    if (
      startAgentSessionResp.errors &&
      startAgentSessionResp.errors.length > 0
    ) {
      console.log('[startAgentSession] Invalid access token')
    } else {
      console.log('[passwordStartAgentSession] Successfully started agent session')
      const { websocket_url } = startAgentSessionResp.data.startAgentSession
      connectWebSocket(websocket_url)
    }
  } catch (err) {
    console.log('[startAgentSession] Request failed')
    console.log('[startAgentSession] ', err.response.error.text)
  }
}


function connectWebSocket(websocket_url) {
  let webSocket = new WebSocket(websocket_url)
  let pingInterval

  function cleanup() {
    detachEventListeners(webSocket)
    clearInterval(pingInterval)
  }

  function handleOpen() {
    console.log(`[WebSocket] Successfully connected to ${websocket_url}`)

    /***************************************************************
     * Periodic ping to prevent idle WebSocket connection time out *
     ***************************************************************/
    pingInterval = setInterval(() => {
      webSocket.send(
        JSON.stringify({
          sig: "PING",
          payload: +new Date()
        })
      )
    }, 60000)

    /*********************************
     * Update agent status to ONLINE *
     *********************************/
    let updateAgentStatus = new MutationUpdateAgentStatus(webSocket, messageMap)
    updateAgentStatus.sendMessage()

    /********************************************************
     * Message subscription -- listen for incoming messages *
     ********************************************************/
    let subscriptionMessage = new SubscriptionMessage(webSocket, messageMap)
    subscriptionMessage.sendMessage()
      .then((subscriptionId) => {
        messageSubscriptionId = subscriptionId
      })

    /**********************************************************************
     * Activity subscription -- listen for people joining or leaving chat *
     **********************************************************************/
    let subscriptionChatActivity = new SubscriptionChatActivity(webSocket, messageMap)
    subscriptionChatActivity.sendMessage()
      .then((subscriptionId) => {
        chatActivityId = subscriptionId
      })
  }

  function handleClose() {
    console.log('[WebSocket] Connection closed abnormally. Reconnecting.')
    cleanup()
    connectWebSocket(websocket_url)
  }

  function handleMessage(message) {
    const data = JSON.parse(message)

    // console.log("data handleMessage:", message)

    if (data.sig === "EOS") {
      console.log('[data] Received EOS signal. Starting a new agent session.')
      cleanup()
      startAgentSession()
    }

    // Log people coming and going from channel.
    if (
      data.sig === SUBSCRIPTION_DATA_SIGNAL &&
      data.subscription_id === chatActivityId &&
      data.payload.data
    ) {
      console.log('[chatActivity] ', JSON.stringify(data.payload.data))
    }

    // Listen for responses from messages that the server process sent. These
    // messages will have an ID and be mapped into a collection.
    if (!!data.id && messageMap.has(data.id)) {
      if (data.payload.errors && data.payload.errors.length > 0) {
        messageMap.get(data.id).messageFailed(data)
      } else {
        messageMap.get(data.id).messageSucceeded(data)
      }
    }

    // Listen to chat messages from visitor.
    if (
      data.sig === SUBSCRIPTION_DATA_SIGNAL &&
      data.subscription_id === messageSubscriptionId &&
      data.payload.data &&
      data.payload.data.message.node.from.__typename === TYPE.VISITOR
    ) {
      const chatMessage = data.payload.data.message.node
      console.log(`[message] Received: '${chatMessage.content}' from: '${chatMessage.from.display_name}'`)

      let chatText = chatMessage.content.toLowerCase()
      switch (chatText) {
        default:
          /********************************************************************
           * Default behavior is to echo back whatever message visitor types. *
           ********************************************************************/
          let replyBackToVisitor = 
            new MutationSendMessage(webSocket, messageMap, chatMessage.channel.id, chatMessage.content)
          replyBackToVisitor.sendMessage()
          break

        case 'send ordered':
          /*********************************************************************
           * Send a series of ordered messages, one after the other. You have  *
           * to wait for a message's response before sending the next message  *
           * if the messages are to be sent in a particular order.             *
           *********************************************************************/
          let sendMessagesinOrder = 
            new MutationSendMessage(webSocket, messageMap, chatMessage.channel.id, "Message 1")

          sendMessagesinOrder.sendMessage()
            .then((success) => {
              (new MutationSendMessage(webSocket, messageMap, chatMessage.channel.id, "Message 2")).sendMessage()
                .then((success) => {
                  (new MutationSendMessage(webSocket, messageMap, chatMessage.channel.id, "Message 3")).sendMessage()
                    .then((success) => {
                      (new MutationSendMessage(webSocket, messageMap, chatMessage.channel.id, "Message 4")).sendMessage()
                    })
                })
            })
          break

        case 'get agents':
          /***************************
           * Get list of chat agents *
           ***************************/
          let queryAgents = new QueryAgents(webSocket, messageMap)
          queryAgents.sendMessage()
          break

        case 'what ice cream flavor':
          /****************************************************
           * Send quick replies structured content to visitor *
           ****************************************************/
          let sendQuickReplies = new MutationSendQuickReplies(webSocket, messageMap, chatMessage.channel.id)
          sendQuickReplies.sendMessage()
          break

        case 'button me':
          /******************************************************
           * Send button template structured content to visitor *
           ******************************************************/
          let sendButtonTemplate = new MutationSendButtonTemplate(webSocket, messageMap, chatMessage.channel.id)
          sendButtonTemplate.sendMessage()
          break

        case 'invite agent':
          /***************************************
           * Invite agent to same channel as bot *
           ***************************************/

          // NOTE: Agent ID here is hardcoded for demo purposes. Also note that this
          // is a Chat channel user ID, *not* a Zendesk Support /api/v2/users.json id.
          let inviteAgent = 
            new MutationInviteAgent(
              webSocket,
              messageMap,
              chatMessage.channel.id,
              'W1sibG9jYWxJZCIsIjkxNzEyODI5ODgiXSxbInR5cGUiLCJBR0VOVCJdXQ=='
            )
          inviteAgent.sendMessage()
            .catch(error => console.log('[inviteAgent] Error transferring to agent'))
        break

        case 'transfer':
          let getDeparments = new QueryDepartments(webSocket, messageMap)
          getDeparments.sendMessage().then((departments) => {

            // Find departments with Online status and transfer to a random selection.
            const onlineDepartments = departments.filter(department => department.status === 'ONLINE')
            if (onlineDepartments.length > 0) {
              const pickRandomDepartment = Math.floor(Math.random() * onlineDepartments.length)
              const onlineDepartment = onlineDepartments[pickRandomDepartment]

              /********************************************************
               * Notify visitor that they are going to be transferred *
               ********************************************************/
              let departmentTransferMessage = 
                new MutationSendMessage(
                  webSocket, 
                  messageMap,
                  chatMessage.channel.id,
                  `You are going to be transferred to ${onlineDepartment.name} department shortly`
                )
              departmentTransferMessage.sendMessage()

              /***********************************
               *Transfer channel to a department *
               ***********************************/
              let transferDepartment = 
                new MutationTransferToDepartment(
                  webSocket,
                  messageMap,
                  chatMessage.channel.id,
                  onlineDepartment.id
                )
              transferDepartment.sendMessage()

            } else {
              /*******************************************************
               * Notify visitor that there are no online departments *
               *******************************************************/
              let failedToTransferMessage = 
                new MutationSendMessage(
                  webSocket, 
                  messageMap,
                  channelToBeTransferred,
                  'Sorry, there are no departments online at the moment.'
                )
              failedToTransferMessage.sendMessage()
            }
          })
        break
      }
    }
  }

  function attachEventListeners(ws) {
    ws.addListener('open', handleOpen)
    ws.addListener('close', handleClose)
    ws.addListener('message', handleMessage)
  }

  function detachEventListeners(ws) {
    ws.removeListener('open', handleOpen)
    ws.removeListener('close', handleClose)
    ws.removeListener('message', handleMessage)
  }

  attachEventListeners(webSocket)
}

startAgentSession()

// keep the script running
process.stdin.resume()