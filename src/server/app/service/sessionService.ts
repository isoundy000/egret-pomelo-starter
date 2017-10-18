import * as events from 'events';
import * as util from 'util';
import * as Logger from 'pomelo-logger';

const logger = Logger.getLogger('SessionService', __filename);

const FRONTEND_SESSION_FIELDS = ['id', 'frontendId', 'uid', '__sessionService__'];
const EXPORTED_SESSION_FIELDS = ['id', 'frontendId', 'uid', 'settings'];

const ST_INITED = 0;
const ST_CLOSED = 1;

interface ISessions {
    [index: string]: Session;
}

interface IUidMap {
    [index: string]: Session[];
}

/**
 * Session service maintains the internal session for each client connection.
 *
 * Session service is created by session component and is only
 * <b>available</b> in frontend servers. You can access the service by
 * `app.get('sessionService')` or `app.sessionService` in frontend servers.
 *
 * @param {Object} opts constructor parameters
 * @class SessionService
 * @constructor
 */
class SessionService {
    public singleSession: boolean;
    public sessions: ISessions;
    public uidMap: IUidMap;

    constructor (opts: any = {}) {
        this.singleSession = !!opts.singleSession;
        this.sessions =  {};
        this.uidMap = {};
    }

    /**
     * Create and return internal session.
     *
     * @param {Integer} sid uniqe id for the internal session 
     * @param {String} frontendId frontend server in which the internal session is created 
     * @param {Object} socket the underlying socket would be held by the internal session  
     *
     * @return {Session}
     *
     * @memberOf SessionService
     * @api private
     */
    private create (sid: number, frontendId: string, socket: object): Session {
        const session = new Session(sid, frontendId, socket, this);
        this.sessions[session.id] = session;
      
        return session;
    }
    /**
     * Bind the session with a user id.
     *
     * @memberOf SessionService
     * @api private
     */
    public bind (sid: number, uid: number, cb: Function) {
        const session = this.sessions[sid];

        if (!session) {
            process.nextTick(() => {
                cb(new Error('session does not exist, sid: ' + sid));
            });
            return;
        }

        if (session.uid) {
            if (session.uid === uid) {
                // already bound with the same uid
                cb();
                return;
            }
    
            // already bound with other uid
            process.nextTick(() => {
                cb(new Error('session has already bound with ' + session.uid));
            });
            return;
        }

        let sessions = this.uidMap[uid];

        if (!!this.singleSession && !!sessions) {
            process.nextTick(() => {
                cb(new Error('singleSession is enabled, and session has already bound with uid: ' + uid));
            });
            return;
        }

        if (!sessions) {
            sessions = this.uidMap[uid] = [];
        }
        for (let i = 0, l = sessions.length; i < l; i++) {
            // session has binded with the uid
            if (sessions[i].id === session.id) {
                process.nextTick(cb);
                return;
            }
        }
        sessions.push(session);
        
        session.bind(uid);
        
        if (cb) {
            process.nextTick(cb);
        }
    }

    /**
     * Unbind a session with the user id.
     *
     * @memberOf SessionService
     * @api private
     */
    public unbind (sid: number, uid: number, cb: Function) {
        const session = this.sessions[sid];
        
        if (!session) {
            process.nextTick(() => {
                cb(new Error('session does not exist, sid: ' + sid));
            });
            return;
        }
        
        if (!session.uid || session.uid !== uid) {
            process.nextTick(() => {
                cb(new Error('session has not bind with ' + session.uid));
            });
            return;
        }

        const sessions = this.uidMap[uid];
        let sess: Session;
        if (sessions) {
            for (let i = 0, l = sessions.length; i < l; i++) {
                sess = sessions[i];
                if (sess.id === sid) {
                    sessions.splice(i, 1);
                    break;
                }
            }

            if (sessions.length === 0) {
                delete this.uidMap[uid];
            }
        }

        session.unbind(uid);
      
        if (cb) {
            process.nextTick(cb);
        }
    }

    /**
     * Get session by id.
     *
     * @param {Number} id The session id
     * @return {Session}
     *
     * @memberOf SessionService
     * @api private
     */
    private get (sid: number) {
        return this.sessions[sid];
    }

    /**
     * Get sessions by userId.
     *
     * @param {Number} uid User id associated with the session
     * @return {Array} list of session binded with the uid
     *
     * @memberOf SessionService
     * @api private
     */
    private getByUid (uid: number) {
        return this.uidMap[uid];
    }

    /**
     * Remove session by key.
     *
     * @param {Number} sid The session id
     *
     * @memberOf SessionService
     * @api private
     */
    public remove (sid: number) {
        const session = this.sessions[sid];
        if (session) {
            const uid = session.uid;
            delete this.sessions[session.id];
      
            const sessions = this.uidMap[uid];
            if (!sessions) {
                return;
            }
      
            for (let i = 0, l = sessions.length; i < l; i++) {
                if (sessions[i].id === sid) {
                    sessions.splice(i, 1);
                    if (sessions.length === 0) {
                        delete this.uidMap[uid];
                    }
                    break;
                }
            }
        }
    }

    /**
     * Import the key/value into session.
     *
     * @api private
     */
    public import (sid: number, key: any, value: any, cb: Function) {
        const session = this.sessions[sid];
        if (!session) {
            invokeCallback(cb, new Error('session does not exist, sid: ' + sid));
            return;
        }
        session.set(key, value);
        invokeCallback(cb);
    }
    /**
     * Import new value for the existed session.
     *
     * @memberOf SessionService
     * @api private
     */
    public importAll (sid: number, settings: any, cb: Function) {
        const session = this.sessions[sid];
        if (!session) {
            invokeCallback(cb, new Error('session does not exist, sid: ' + sid));
            return;
        }
      
        for (const f in settings) {
            session.set(f, settings[f]);
        }
        invokeCallback(cb);
    }

    /**
     * Kick all the session offline under the user id.
     *
     * @param {Number}   uid user id asscociated with the session
     * @param {Function} cb  callback function
     *
     * @memberOf SessionService
     */
    public kick (uid: number, reason: any, cb: Function) {
        // compatible for old kick(uid, cb);
        if (typeof reason === 'function') {
            // tslint:disable-next-line:no-param-reassign
            cb = reason;
            // tslint:disable-next-line:no-param-reassign
            reason = 'kick';
        }
        const sessions = this.getByUid(uid);

        if (sessions) {
            // notify client
            const sids: any[] = [];

            sessions.forEach((session) => {
                sids.push(session.id);
            });
        
            sids.forEach((sid) => {
                this.sessions[sid].closed(reason);
            });
        
            process.nextTick(() => {
                invokeCallback(cb);
            });
        } else {
            process.nextTick(() => {
                invokeCallback(cb);
            });
        }
    }

    /**
     * Kick a user offline by session id.
     *
     * @param {Number}   sid session id
     * @param {Function} cb  callback function
     *
     * @memberOf SessionService
     */
    public kickBySessionId (sid: number, reason: any, cb: Function) {
        if (typeof reason === 'function') {
            // tslint:disable-next-line:no-param-reassign
            cb = reason;
            // tslint:disable-next-line:no-param-reassign
            reason = 'kick';
        }
        
        const session = this.get(sid);
        
        if (session) {
            // notify client
            session.closed(reason);
            process.nextTick(() => {
                invokeCallback(cb);
            });
        } else {
            process.nextTick(() => {
                invokeCallback(cb);
            });
        }
    }

    /**
     * Get client remote address by session id.
     *
     * @param {Number}   sid session id
     * @return {Object} remote address of client
     *
     * @memberOf SessionService
     */
    public getClientAddressBySessionId (sid: number) {
        const session = this.get(sid);
        if (session) {
            const socket = session.__socket__;
            return socket.remoteAddress;
        } else {
            return null;
        }
    }

    /**
     * Send message to the client by session id.
     *
     * @param {String} sid session id
     * @param {Object} msg message to send
     *
     * @memberOf SessionService
     * @api private
     */
    private sendMessage (sid: number, msg: string) {
        const session = this.sessions[sid];
        
        if (!session) {
            logger.debug('Fail to send message for non-existing session, sid: ' + sid + ' msg: ' + msg);
            return false;
        }
        
        return send(this, session, msg);
    }

    /**
     * Send message to the client by user id.
     *
     * @param {String} uid userId
     * @param {Object} msg message to send
     *
     * @memberOf SessionService
     * @api private
     */
    private sendMessageByUid (uid: number, msg: string) {
        const sessions = this.uidMap[uid];
        
        if (!sessions) {
            logger.debug('fail to send message by uid for non-existing session. uid: %j', uid);
            return false;
        }
        
        for (let i = 0, l = sessions.length; i < l; i++) {
            send(this, sessions[i], msg);
        }
    }

    /**
     * Iterate all the session in the session service.
     *
     * @param  {Function} cb callback function to fetch session
     * @api private
     */
    private forEachSession (cb: Function) {
        for (const sid in this.sessions) {
            cb(this.sessions[sid]);
        }
    }

    /**
     * Iterate all the binded session in the session service.
     *
     * @param  {Function} cb callback function to fetch session
     * @api private
     */
    private forEachBindedSession (cb: Function) {
        let i: number;
        let l: number;
        let sessions: Session[];
        for (const uid in this.uidMap) {
            sessions = this.uidMap[uid];
            for (i = 0, l = sessions.length; i < l; i++) {
                cb(sessions[i]);
            }
        }
    }

    /**
     * Get sessions' quantity in specified server.
     *
     */
    public getSessionsCount () {
        return size(this.sessions);
    }
}

/**
 * Send message to the client that associated with the session.
 *
 * @api private
 */

function send(service: SessionService, session: Session, msg: string) {
    session.send(msg);
  
    return true;
}

/**
 * Session maintains the relationship between client connection and user information.
 * There is a session associated with each client connection. And it should bind to a
 * user id after the client passes the identification.
 *
 * Session is created in frontend server and should not be accessed in handler.
 * There is a proxy class called BackendSession in backend servers and FrontendSession 
 * in frontend servers.
 * @param {sid, frontendId, socket, service} constructor parameters
 * @class Session
 * @constructor
 */
class Session {
    [key: string]: any;

    public id: number;
    public frontendId: string;
    public uid: number;
    public settings: any;

    public emit: Function;
    public on: Function;
    // tslint:disable-next-line:variable-name
    public __socket__: any;
    // tslint:disable-next-line:variable-name
    public __sessionService__: SessionService;
    // tslint:disable-next-line:variable-name    
    public __state__: number;

    constructor (sid: number, frontendId: string, socket: any, service: SessionService) {
        this.id = sid;
        this.frontendId = frontendId;
        this.uid = null;
        this.settings = {};

        this.__socket__ = socket;
        this.__sessionService__ = service;
        this.__state__ = ST_INITED;

        events.EventEmitter.call(this);
    }
    /*
     * Export current session as frontend session.
     */
    public toFrontendSession () {
        return new FrontendSession(this);
    }

    /**
     * Bind the session with the the uid.
     *
     * @param {Number} uid User id
     * @api public
     */
    public bind (uid: number) {
        this.uid = uid;
        this.emit('bind', uid);
    }

    /**
     * Unbind the session with the the uid.
     *
     * @param {Number} uid User id
     * @api private
     */
    public unbind (uid: number) {
        this.uid = null;
        this.emit('unbind', uid);
    }

    /**
     * Set values (one or many) for the session.
     *
     * @param {String|Object} key session key
     * @param {Object} value session value
     * @api public
     */
    public set (key: any, value: any) {
        if (isObject(key)) {
            for (const i in key) {
                this.settings[i] = key[i];
            }
        } else {
            this.settings[key] = value;
        }
    }

    /**
     * Remove value from the session.
     *
     * @param {String} key session key
     * @api public
     */
    public remove (key: string) {
        delete this[key];
    }

    /**
     * Get value from the session.
     *
     * @param {String} key session key
     * @return {Object} value associated with session key
     * @api public
     */
    public get (key: string) {
        return this.settings[key];
    }

    /**
     * Send message to the session.
     *
     * @param  {Object} msg final message sent to client
     */
    public send (msg: any) {
        this.__socket__.send(msg);
    }

    /**
     * Send message to the session in batch.
     *
     * @param  {Array} msgs list of message
     */
    public sendBatch (msgs: any) {
        this.__socket__.sendBatch(msgs);
    }

    /**
     * Closed callback for the session which would disconnect client in next tick.
     *
     * @api public
     */
    public closed (reason: any) {
        logger.debug('session on [%s] is closed with session id: %s', this.frontendId, this.id);
        if (this.__state__ === ST_CLOSED) {
            return;
        }
        this.__state__ = ST_CLOSED;
        this.__sessionService__.remove(this.id);
        this.emit('closed', this.toFrontendSession(), reason);
        this.__socket__.emit('closing', reason);
      
        process.nextTick(() => {
            this.__socket__.disconnect();
        });
    }
}

/**
 * Frontend session for frontend server.
 */
class FrontendSession {
    public id: number;
    public frontendId: string;
    public uid: number;
    public settings: any; 

    // tslint:disable-next-line:variable-name
    public __session__: Session;
    // tslint:disable-next-line:variable-name
    public __sessionService__: SessionService;

    constructor (session: Session) {
        clone(session, this, FRONTEND_SESSION_FIELDS);
        // deep copy for settings
        this.settings = dclone(session.settings);
        this.__session__ = session;
        events.EventEmitter.call(this);
    }

    public bind (uid: number, cb: Function) {
        this.__sessionService__.bind(this.id, uid, (err: Error) => {
            if (!err) {
                this.uid = uid;
            }
            invokeCallback(cb, err);
        });
    }

    public unbind (uid: number, cb: Function) {
        this.__sessionService__.unbind(this.id, uid, (err: Error) => {
            if (!err) {
                this.uid = null;
            }
            invokeCallback(cb, err);
        });
    }

    public set (key: any, value: any) {
        this.settings[key] = value;
    }

    public get (key: any) {
        return this.settings[key];
    }

    public push (key: any, cb: Function) {
        this.__sessionService__.import(this.id, key, this.get(key), cb);
    }

    public pushAll (cb: Function) {
        this.__sessionService__.importAll(this.id, this.settings, cb);
    }

    public on (event: any, listener: any) {
        events.EventEmitter.prototype.on.call(this, event, listener);
        this.__session__.on(event, listener);
    }

    public export () {
        const res = {};
        clone(this, res, EXPORTED_SESSION_FIELDS);
        return res;
    }
}

util.inherits(Session, events.EventEmitter);
util.inherits(FrontendSession, events.EventEmitter);
/************************************ utils ************************************/
/**
 * Invoke callback with check
 */
function invokeCallback(cb: Function, ...enterArgs: any[]) {
    if (typeof cb === 'function') {
        const len = arguments.length;
        if (len === 1) {
            return cb();
        }
  
        if (len === 2) {
            return cb(arguments[1]);
        }
  
        if (len === 3) {
            return cb(arguments[1], arguments[2]);
        }
  
        if (len === 4) {
            return cb(arguments[1], arguments[2], arguments[3]);
        }
  
        const args = Array(len - 1);
        for (let i = 1; i < len; i++)
            args[i - 1] = arguments[i];
    }
}

/**
 * Get the count of elements of object
 */
function size(obj: any) {
    let count = 0;
    for (const i in obj) {
        if (obj.hasOwnProperty(i) && typeof obj[i] !== 'function') {
            count++;
        }
    }
    return count;
}

function clone(src: any, dest: any, includes: any) {
    let f;
    for (let i = 0, l = includes.length; i < l; i++) {
        f = includes[i];
        dest[f] = src[f];
    }
}
  
function dclone(src: any) {
    const res: any = {};
    for (const f in src) {
        res[f] = src[f];
    }
    return res;
}

function isObject(arg: any) {
    return typeof arg === 'object' && arg !== null;
}