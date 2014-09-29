/** @jsx React.DOM */
/* global gapi */

var ActionType = require('./ActionType.js');
var Cache = require('./Cache.js');
var ClientID = require('./ClientID.js');
var Dispatcher = require('./Dispatcher.js');
var EventEmitter = require('events').EventEmitter;
var MessageTranslator = require('./MessageTranslator');
var RSVP = require('rsvp');
var _ = require('lodash');
var utf8 = require('utf8');

var emitter = new EventEmitter();
var messageCache = new Cache('messages');
var isAvailable = false;
var pendingRequests = [];

window.handleGoogleClientLoad = function() {
  tryAuthorize(/*immediate*/ true);
};

function tryAuthorize(immediate) {
  var config = {
    client_id: '108971935462-ied7vg89qivj0bsso4imp6imhvpuso5u.apps.googleusercontent.com',
    scope: 'email https://www.googleapis.com/auth/gmail.modify',
    immediate
  };
  gapi.auth.authorize(config, whenAuthenticated);
}

function whenAuthenticated(authResult) {
  if (authResult && !authResult.error) {
    emitter.emit('isAuthororized', true);
    gapi.client.load('gmail', 'v1', whenLoaded);
  } else {
    emitter.emit('isAuthororized', false);
  }
}

function whenLoaded() {
  isAvailable = true;
  if (pendingRequests.length) {
    pendingRequests.forEach(request => request());
  }
  pendingRequests = [];
}

function whenGoogleApiAvailable(fn) {
  if (isAvailable) {
    fn();
  } else {
    pendingRequests.push(fn);
  }
}

var listThreads = wrapAPICallWithEmitter(function(options) {
  return new RSVP.Promise((resolve, reject) => {
    whenGoogleApiAvailable(() => {
      var request = gapi.client.gmail.users.threads.list({
        userID: 'me',
        maxResults: options.maxResults,
        q: options.query || null,
        pageToken: options.pageToken || null,
      });

      request.execute(response => {
        if (!handleError(response, reject)) {
          return;
        }

        var threadIDs = (response.threads || []).map(m => m.id);

        if (!threadIDs.length) {
          resolve({
            nextPageToken: null,
            resultSizeEstimate: 0,
            items: [],
          });
          return;
        }

        var batch = gapi.client.newHttpBatch();
        threadIDs.forEach(id => {
          batch.add(
            gapi.client.request({
              path: 'gmail/v1/users/me/threads/' + id
            }),
            {id}
            // TODO: file a task, this is broken :(
            // dump(gapi.client.gmail.users.messages.get({id: message.id}))
          );
        });

        batch.execute(itemsResponse => {
          if (!handleError(response, reject)) {
            return;
          }

          var allMessages = [];
          var threads = threadIDs.map(threadID => {
            var thread = itemsResponse[threadID].result;
            var messages = thread.messages.map(MessageTranslator.translate);
            allMessages.push.apply(allMessages, messages);
            return {
              id: threadID,
              messageIDs: _.pluck(messages, 'id'),
            };
          });

          Dispatcher.dispatch({
            type: ActionType.Message.ADD_MANY,
            messages: allMessages,
          });

          resolve({
            nextPageToken: response.nextPageToken,
            resultSizeEstimate: response.resultSizeEstimate,
            items: threads,
          });
        });
      });
    });
  });
});

var listMessages = wrapAPICallWithEmitter(function(options) {
  return new RSVP.Promise((resolve, reject) => {
    whenGoogleApiAvailable(() => {
      var request = gapi.client.gmail.users.messages.list({
        userID: 'me',
        maxResults: options.maxResults,
        q: options.query || null,
        pageToken: options.pageToken || null,
      });

      request.execute(response => {
        if (!handleError(response, reject)) {
          return;
        }

        var messageIDs = response.messages.map(m => m.id);
        var cachedMessagesByID = {};
        var batch;

        messageIDs.forEach(id => {
          var cachedMessage = messageCache.get(id);
          if (cachedMessage) {
            cachedMessagesByID[id] = cachedMessage;
            return;
          }

          batch = batch || gapi.client.newHttpBatch();
          batch.add(
            gapi.client.request({
              path: 'gmail/v1/users/me/messages/' + id
            }),
            {id: id}
            // TODO: file a task, this is broken :(
            // dump(gapi.client.gmail.users.messages.get({id: message.id}))
          );
        });

        if (!batch) {
          resolve({
            nextPageToken: response.nextPageToken,
            resultSizeEstimate: response.resultSizeEstimate,
            items: _.map(cachedMessagesByID, MessageTranslator.translate),
          });
          return;
        }

        batch.execute(itemsResponse => {
          if (!handleError(response, reject)) {
            return;
          }

          resolve({
            nextPageToken: response.nextPageToken,
            resultSizeEstimate: response.resultSizeEstimate,
            items: messageIDs.map(id => {
              var msg = itemsResponse[id] ?
                itemsResponse[id].result :
                messageCache.get(id);
              messageCache.set(msg.id, msg);
              return MessageTranslator.translate(msg);
            }),
          });
        });
      });
    });
  });
});

var listLabels = wrapAPICallWithEmitter(function() {
  return new RSVP.Promise((resolve, reject) => {
    whenGoogleApiAvailable(() => {
      var request = gapi.client.gmail.users.labels.list({
        userID: 'me',
      });

      request.execute(response => {
        if (!handleError(response, reject)) {
          return;
        }

        resolve(response.labels);
      });
    });
  });
});

function simpleAPICall(getRequest) {
  return wrapAPICallWithEmitter(options => {
    return new RSVP.Promise((resolve, reject) => {
      whenGoogleApiAvailable(() => {
        var request = getRequest(options);

        request.execute(response => {
          if (!handleError(response, reject)) {
            return;
          }

          resolve(response);
        });
      });
    });
  });
}

var markThreadAsRead = simpleAPICall(options => {
  return gapi.client.gmail.users.threads.modify({
    userID: 'me',
    id: options.threadID,
    removeLabelIds: ['UNREAD'],
  });
});

var archiveThread = simpleAPICall(options => {
  return gapi.client.gmail.users.threads.modify({
    userID: 'me',
    id: options.threadID,
    removeLabelIds: ['INBOX'],
  });
});

var markThreadAsUnread = simpleAPICall(options => {
  return gapi.client.gmail.users.threads.modify({
    userID: 'me',
    id: options.threadID,
    addLabelIds: ['UNREAD'],
  });
});

var unstarThread = simpleAPICall(options => {
  return gapi.client.gmail.users.threads.modify({
    userID: 'me',
    id: options.threadID,
    removeLabelIds: ['STARRED'],
  });
});

var starThread = simpleAPICall(options => {
  return gapi.client.gmail.users.threads.modify({
    userID: 'me',
    id: options.threadID,
    addLabelIds: ['STARRED'],
  });
});

var inProgressAPICalls = {};
function wrapAPICallWithEmitter(apiCall) {
  return function(options) {
    var id = ClientID.get();
    inProgressAPICalls[id] = true;
    emitter.emit('start', id);

    return apiCall(options).finally(() => {
      delete inProgressAPICalls[id];
      emitter.emit('stop', id);
      if (!Object.keys(inProgressAPICalls).length) {
        emitter.emit('allStopped');
      }
    });
  };
}

function isInProgress() {
  return !!Object.keys(inProgressAPICalls).length;
}

function subscribe(eventName, callback) {
  emitter.on(eventName, callback);
  return {
    remove() {
      emitter.removeListener(eventName, callback);
    }
  };
}

function handleError(response, reject) {
  if (response.error) {
    reject();
    return false;
  }
  return true;
}

window.API = Object.assign(module.exports, {
  archiveThread,
  isInProgress,
  listLabels,
  listMessages,
  listThreads,
  login: tryAuthorize.bind(null, /*immediate*/ false),
  markThreadAsRead,
  markThreadAsUnread,
  starThread,
  subscribe,
  unstarThread,
});
