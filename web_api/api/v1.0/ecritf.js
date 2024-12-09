
var SMQ={};

SMQ.utf8={
    length: function(inp) {
        var outp = 0;
        for(var i = 0; i<inp.length; i++) {
	    var charCode = inp.charCodeAt(i);
	    if(charCode > 0x7FF) {
	        if(0xD800 <= charCode && charCode <= 0xDBFF) {
		    i++;
		    outp++;
	        }
	        outp +=3;
	    }
	    else if(charCode > 0x7F) outp +=2;
	    else outp++;
        }
        return outp;
    },
    encode: function(inp, outp, start) {
        if(outp == undefined)
            outp = new Uint8Array(SMQ.utf8.length(inp))
        var ix = start ? start : 0;
        for(var i = 0; i<inp.length; i++) {
	    var charCode = inp.charCodeAt(i);
	    if(0xD800 <= charCode && charCode <= 0xDBFF) {
	        var lowCharCode = inp.charCodeAt(++i);
	        if(isNaN(lowCharCode)) return null;
	        charCode = ((charCode-0xD800)<<10)+(lowCharCode-0xDC00)+0x10000;
	    }
	    if(charCode <= 0x7F) outp[ix++] = charCode;
	    else if(charCode <= 0x7FF) {
	        outp[ix++] = charCode>>6  & 0x1F | 0xC0;
	        outp[ix++] = charCode     & 0x3F | 0x80;
	    }
            else if(charCode <= 0xFFFF) {    				    
	        outp[ix++] = charCode>>12 & 0x0F | 0xE0;
	        outp[ix++] = charCode>>6  & 0x3F | 0x80;   
	        outp[ix++] = charCode     & 0x3F | 0x80;   
	    }
            else {
	        outp[ix++] = charCode>>18 & 0x07 | 0xF0;
	        outp[ix++] = charCode>>12 & 0x3F | 0x80;
	        outp[ix++] = charCode>>6  & 0x3F | 0x80;
	        outp[ix++] = charCode     & 0x3F | 0x80;
	    };
        }
        return outp;
    },
    decode: function(inp, offset, length) {
        var outp = "";
        var utf16;
        if(offset == undefined) offset = 0;
        if(length == undefined) length = (inp.length - offset);
        var ix = offset;
        while(ix < offset+length) {
	    var b1 = inp[ix++];
	    if(b1 < 128) utf16 = b1;
	    else  {
	        var b2 = inp[ix++]-128;
	        if(b2 < 0) return null;
	        if(b1 < 0xE0)
		    utf16 = 64*(b1-0xC0) + b2;
	        else { 
		    var b3 = inp[ix++]-128;
		    if(b3 < 0) return null;
		    if(b1 < 0xF0) utf16 = 4096*(b1-0xE0) + 64*b2 + b3;
		    else {
		        var b4 = inp[ix++]-128;
		        if(b4 < 0) return null;
		        if(b1 < 0xF8) utf16 = 262144*(b1-0xF0)+4096*b2+64*b3+b4;
		        else return null;
		    }
	        }
	    }  
	    if(utf16 > 0xFFFF)
	    {
	        utf16 -= 0x10000;
	        outp += String.fromCharCode(0xD800 + (utf16 >> 10));
	        utf16 = 0xDC00 + (utf16 & 0x3FF);
	    }
	    outp += String.fromCharCode(utf16);
        }
        return outp;
    }
};


SMQ.wsURL = function(path) {
    if ((window !== undefined) && (window.location !== undefined)) {
        var l = window.location;
        if(path == undefined) path = l.pathname;
        return ((l.protocol === "https:") ? "wss://" : "ws://") +
            l.hostname +
            (l.port!=80 && l.port!=443 && l.port.length!=0 ? ":" + l.port : "") +
            path;
    } else {
        return "wss://ecritf.paytec.ch/smq.lsp";
    }
};


SMQ.websocket = function() {
    if (window !== undefined) {
        if("WebSocket" in window && window.WebSocket != undefined)
            return true;
        return false;
    } else {
        return (WebSocket !== undefined);
    }
};


SMQ.Client = function(url, opt) {
    if (!(this instanceof SMQ.Client)) return new SMQ.Client(url, opt);
    if(arguments.length < 2 && typeof(url)=="object") {
        opt=url;
        url=null;
    }
    var self = this;
    var SMQ_VERSION = 1;
    var MSG_INIT = 1;
    var MSG_CONNECT = 2;
    var MSG_CONNACK = 3;
    var MSG_SUBSCRIBE = 4;
    var MSG_SUBACK = 5;
    var MSG_CREATE = 6;
    var MSG_CREATEACK = 7;
    var MSG_PUBLISH = 8;
    var MSG_UNSUBSCRIBE = 9;
    var MSG_DISCONNECT = 11;
    var MSG_PING = 12;
    var MSG_PONG = 13;
    var MSG_OBSERVE = 14;
    var MSG_UNOBSERVE = 15;
    var MSG_CHANGE = 16;
    var MSG_CREATESUB  = 17
    var MSG_CREATESUBACK = 18;
    var socket;
    var connected=false;
    var selfTid;
    var onclose;
    var onconnect;
    var intvtmo;
    if( ! url ) url = SMQ.wsURL();
    var tid2topicT={}; //Key= tid, val = topic name
    var topic2tidT={}; //Key=topic name, val=tid
    var topicAckCBT={}; //Key=topic name, val=array of callback funcs
    var tid2subtopicT={}; //Key= tid, val = subtopic name
    var subtopic2tidT={}; //Key=sub topic name, val=tid
    var subtopicAckCBT={}; //Key=sub topic name, val=array of callback funcs
    var onMsgCBT={}; //Key=tid, val = {all: CB, subtops: {stid: CB}}
    var observeT={}; //Key=tid, val = onchange callback
    var pendingCmds=[]; //List of functions to exec on connect

    if(!opt) opt={}

    var n2h32=function(d,ix) {
        return (d[ix]*16777216) + (d[ix+1]*65536) + (d[ix+2]*256) + d[ix+3];
    };

    var h2n32=function(n,d,ix) {
        d[ix]   = n >>> 24;
        d[ix+1] = n >>> 16;
        d[ix+2] = n >>> 8;
        d[ix+3] = n;
    };

    var execPendingCmds=function() {
        for(var i = 0 ; i < pendingCmds.length; i++)
            pendingCmds[i]();
        pendingCmds=[];
    };

    var decodeTxt = function(data, ptid, tid, subtid) {
        var msg = SMQ.utf8.decode(data);
        if( ! msg ) {
            if(data.length == 0) return "";
            console.log("Cannot decode UTF8 for tid=",
                        tid,", ptid=",ptid,", subtid=",subtid);
            self.onmsg(data, ptid, tid, subtid);
        }
        return msg;
    };

    var dispatchTxt = function(cbFunc, data, ptid, tid, subtid) {
        var msg = decodeTxt(data, ptid, tid, subtid);
        if(msg) cbFunc(msg, ptid, tid, subtid);
    };

    var dispatchJSON = function(cbFunc, data, ptid, tid, subtid) {
        var msg = decodeTxt(data, ptid, tid, subtid);
        if(!msg) return;
        var j;
        try {
            j=JSON.parse(msg);
        }
        catch(e) {
            console.log("Cannot parse JSON for tid=",
                        tid,", ptid=",ptid,", subtid=",subtid);
            self.onmsg(data, ptid, tid, subtid);
        }
        try {
            cbFunc(j, ptid, tid, subtid);
        }
        catch(e) {
            console.log("Callback failed: "+e+"\n"+e.stack);
        }

    };

    var pushElem=function(obj,key,elem) {
        var newEntry=false;
        var arr = obj[key];
        if( ! arr ) {
            arr =[];
            obj[key]=arr;
            newEntry=true;
        }
        arr.push(elem);
        return newEntry;
    };

    var cancelIntvConnect=function() {
        if(intvtmo) clearTimeout(intvtmo);
        intvtmo=null;
    };

    var socksend=function(data) {
        try {socket.send(data);}
        catch(e) {onclose(e.message, true); }
    };

    var createSock=function(isReconnect) {
        try {
            socket = new WebSocket(url);
        }
        catch(err) {
            socket=null;
        }
        if( ! socket ) {
            onclose("Cannot create WebSocket object", true);
            return;
        }
        socket.binaryType = 'arraybuffer';
        socket.onmessage = function(evt) {
            cancelIntvConnect();
            onconnect(evt, isReconnect); };
        socket.onclose = function(evt) {
            onclose("Unexpected socket close", true); };
        socket.onerror = function (err) {
            onclose(connected ? "Socket error" : "Cannot connect", true);
        }
    };

    // Restore all tid's and subscriptions after a disconnect/reconnect
    var restore = function(newTid, rnd, ipaddr) {
        var tid2to = tid2topicT;
        var to2tid = topic2tidT;
        var tid2sto = tid2subtopicT;
        var sto2tid = subtopic2tidT;
        var onmsgcb = onMsgCBT;
        var obs = observeT;
        tid2topicT={};
        topic2tidT={};
        topicAckCBT={};
        tid2subtopicT={};
        subtopic2tidT={};
        subtopicAckCBT={};
        onMsgCBT={};
        observeT={};
        var oldTid = selfTid;
        selfTid = newTid;

        var onResp2Cnt=10000;
        var onResp1Cnt=10000;

        var onresp2 = function() { // (3) Re-create observed tids
            if(--onResp2Cnt <= 0 && connected) {
                onResp2Cnt=10000;
                for(var tid in obs) {
                    var topic = tid2to[tid];
                    if(topic) {
                        self.observe(topic, obs[tid]);
                    }
                }
                if(connected) {
                    execPendingCmds();
                    if(self.onreconnect)
                        self.onreconnect(newTid, rnd, ipaddr);
                }
                else
                    onclose("reconnecting failed",false);
            }
        };
        var onresp1 = function() { // (2) Re-create subscriptions
            if(--onResp1Cnt <= 0 && connected) {
                onResp1Cnt=10000;
                try {
                    for(var tid in onmsgcb) {
                        var topic = tid == oldTid ? "self" : tid2to[tid];
                        if(topic) {
                            var t = onmsgcb[tid];
                            if(t.onmsg) {
                                onResp2Cnt++;
                                self.subscribe(topic, {
                                    onmsg:t.onmsg,onack:onresp2});
                            }
                            for(var stid in t.subtops) {
                                var subtop = tid2sto[stid];
                                if(subtop) {
                                    onResp2Cnt++;
                                    self.subscribe(topic,subtop,{
                                        onmsg:t.subtops[stid],onack:onresp2});
                                }
                            }
                        }
                    }
                }
                catch(e) {console.log(e.message);}
                if(connected) {
                    onResp2Cnt -= 10000;
                    if(onResp2Cnt <= 0)
                        onresp2();
                }
            }
        };
        try { // (1) Re-create tids and subtids
            for(var t in to2tid) {onResp1Cnt++; self.create(to2tid[t],onresp1);}
            for(var t in sto2tid) {onResp1Cnt++; self.createsub(sto2tid[t],onresp1);}
        }
        catch(e) {}
        onResp1Cnt -= 10000;
        if(connected && onResp1Cnt <= 0)
            onresp1();
    };

    onclose=function(msg,ok2reconnect) {
        if(socket) {
            connected=false;
            var s = socket;
            socket=null;
            //Prevent further event messages
            try {s.onopen=s.onmessage=s.onclose=s.onerror=function(){};}
            catch(err) {}
            try { s.close(); } catch(err) {}
            if(self.onclose) {
                var timeout = self.onclose(msg,ok2reconnect);
                if(ok2reconnect && typeof(timeout) =="number") {
                    if(!intvtmo) {
                        if(timeout < 1000) timeout = 1000;
                        intvtmo=setInterval(function() {
                            if( ! socket ) createSock(true);
                        },timeout);
                    }
                }
                else
                    cancelIntvConnect();
            }
        }
        connected=false;
    };

    var onmessage = function(evt) {
        var d = new Uint8Array(evt.data);
        switch(d[0]) {

        case MSG_SUBACK:
        case MSG_CREATEACK:
        case MSG_CREATESUBACK:
            var accepted=d[1] ? false : true;
            var tid=n2h32(d,2);
            var topic=SMQ.utf8.decode(d,6);
            if(accepted) {
                if(d[0] == MSG_CREATESUBACK) {
                    tid2subtopicT[tid]=topic;
                    subtopic2tidT[topic]=tid;
                }
                else {
                    tid2topicT[tid]=topic;
                    topic2tidT[topic]=tid;
                }
            }
            var t = d[0] == MSG_CREATESUBACK ? subtopicAckCBT : topicAckCBT;
            var arr=t[topic];
            t[topic]=null;
            if(arr) {
                for (var i = 0; i < arr.length; i++)
                    arr[i](accepted,topic,tid);
            }
            break;

        case MSG_PUBLISH:
            var tid = n2h32(d,1);
            var ptid = n2h32(d,5);
            var subtid = n2h32(d,9);
            var data = new Uint8Array(evt.data,13)
            var cbFunc;
            var t = onMsgCBT[tid];
            if(t) {
                cbFunc = t.subtops[subtid];
                if(!cbFunc) cbFunc = t.onmsg ? t.onmsg : self.onmsg;
            }
            else
                cbFunc = self.onmsg;
            cbFunc(data, ptid, tid, subtid);
            break;

        case MSG_DISCONNECT:
            var msg;
            if(d.length > 1)
                msg=SMQ.utf8.decode(d,1);
            onclose(msg ? msg : "disconnect",false);
            break;

        case MSG_PING:
            d[0] = MSG_PONG;
            socksend(d.buffer);
            break;

        case MSG_PONG:
            console.log("pong");
            break;

        case MSG_CHANGE:
            var tid = n2h32(d,1);
            var func = observeT[tid];
            if(func) {
                var subsribers = n2h32(d,5);
                var topic = tid2topicT[tid];
                if(!topic && subsribers == 0)
                    observeT[tid]=null; /* Remove ephemeral */
                func(subsribers, topic ? topic : tid);
            }
            break;

        default:
            onclose("protocol error", true);
        }
    };

    onconnect = function(evt, isReconnect) {
        if( ! socket ) return;
        cancelIntvConnect();
        var d = new Uint8Array(evt.data);
        if(d[0] == MSG_INIT)
        {
            if(d[1] == SMQ_VERSION)
            {
                var credent
                var rnd=n2h32(d,2);
                var ipaddr=SMQ.utf8.decode(d,6);
                var uid = SMQ.utf8.encode(opt.uid ? opt.uid : ipaddr+rnd);
                var info = opt.info ? SMQ.utf8.encode(opt.info) : null;
                if(self.onauth) {
                    credent=self.onauth(rnd, ipaddr);
                    if(credent) credent = SMQ.utf8.encode(credent);
                }
                var out = new Uint8Array(3 + uid.length + 
                                         (credent ? 1+credent.length : 1) + 
                                         (info ? info.length : 0));
                out[0] = MSG_CONNECT;
                out[1] = SMQ_VERSION;
                out[2] = uid.length;
                var ix;
                var i;
                for(i = 0; i < uid.length; i++) out[3+i]=uid[i];
                ix=3+i;
                if(credent) {
                    out[ix++]=credent.length;
                    for(i = 0; i < credent.length; i++) out[ix++]=credent[i];
                }
                else
                    out[ix++]=0;
                if(info) {
                    for(i = 0; i < info.length; i++)
                        out[ix+i]=info[i];
                }
                socket.onmessage = function(evt) {
                    var d = new Uint8Array(evt.data);
                    if(d[0] == MSG_CONNACK)
                    {
                        if(d[1] == 0)
                        {
                            var tid = n2h32(d,2);
                            connected=true;
                            socket.onmessage=onmessage;
                            if(isReconnect) {
                                restore(tid,rnd,ipaddr);
                            }
                            else {
                                selfTid=tid;
                                execPendingCmds();
                                if(self.onconnect)
                                    self.onconnect(selfTid, rnd, ipaddr); 
                            }
                        }
                        else
                            onclose(SMQ.utf8.decode(d,6), false);
                    }
                    else
                        onclose("protocol error", false);
                };
                socksend(out.buffer);
            }
            else
                onclose("Incompatible ver "+d[1], false);
        }
        else
            onclose("protocol error", false);
    };

    var subOrCreate=function(topic, subtopic, settings, isCreate) {
        if( ! connected ) {
            pendingCmds.push(function() {
                subOrCreate(topic, subtopic, settings, isCreate);
            });
            return;
        }
        if(typeof(subtopic) == "object") {
            settings = subtopic;
            subtopic=null;
        }
        if(!settings) settings={}
        var onack=function(accepted,topic,tid,stopic,stid) {
            if(settings.onack) settings.onack(accepted,topic,tid,stopic,stid);
            else if(!accepted) console.log("Denied:",topic,tid,stopic,stid);
            if(!isCreate && accepted && settings.onmsg) {
                var t = onMsgCBT[tid];
                if(!t) t = onMsgCBT[tid] = {subtops:{}};
                var onmsg = settings.onmsg;
                var orgOnmsg=onmsg;
                var dt=settings.datatype;
                if(dt) {
                    if(dt == "json") {
                        onmsg=function(data, ptid, tid, subtid) {
                            dispatchJSON(orgOnmsg, data, ptid, tid, subtid);
                        };
                    } 
                    else if(dt == "text") {
                        onmsg=function(data, ptid, tid, subtid) {
                            dispatchTxt(orgOnmsg, data, ptid, tid, subtid);
                        };
                    }
                }
                if(stid) t.subtops[stid] = onmsg;
                else t.onmsg = onmsg;
            }
        };
        if(subtopic) {
            var orgOnAck = onack;
            onack=function(accepted,topic,tid) {
                if(accepted) {
                    self.createsub(subtopic, function(accepted,stopic,stid) {
                        orgOnAck(accepted,topic,tid,stopic,stid)
                    });
                }
                else
                    orgOnAck(accepted,topic,tid);
            };
        }
        if(topic == "self")
            onack(true,topic, selfTid);
        else if(topic2tidT[topic] && isCreate)
            onack(true,topic,topic2tidT[topic]);
        else {
            if(typeof topic == "number") {
                topic2tidT[topic]=topic;
                tid2topicT[topic]=topic;
                onack(true, topic, topic);
            }
            else if(typeof topic == "string") {
                if(pushElem(topicAckCBT,topic,onack)) {
                    var d = new Uint8Array(SMQ.utf8.length(topic)+1)
                    d[0] = isCreate ? MSG_CREATE : MSG_SUBSCRIBE;
                    SMQ.utf8.encode(topic,d,1);
                    socksend(d.buffer);
                }
            }
            else
                throw new Error("Invalid topic type");
        }
    };

    var getTid=function(topic) {
        var tid;
        if(typeof topic =="string") {
            tid = topic2tidT[topic];
            if( ! tid ) throw new Error("tid not found");
        }
        else
            tid = topic;
        return tid;
    };

    self.publish=function(data,topic,subtopic) {
        if( ! connected ) {
            pendingCmds.push(function() {
                self.publish(data,topic,subtopic);
            });
            return;
        }
        var d;
        if(typeof data == "string") {
            d = new Uint8Array(SMQ.utf8.length(data)+13)
            SMQ.utf8.encode(data,d,13);
        }
        else {
            d = new Uint8Array(data.length + 13);
            for(i = 0; i < data.length; i++)
                d[13+i]=data[i];
        }
        d[0] = MSG_PUBLISH;
        h2n32(selfTid,d,5);
        var tid,stid;
        var sendit=function() { 
            h2n32(tid,d,1);
            h2n32(stid,d,9);
            socksend(d.buffer);
        };
        if(typeof(topic) == "string") {
            tid = topic2tidT[topic];
            if(!tid) {
                var orgSendit1=sendit;
                sendit=function() {
                    self.create(topic,function(ok,x,t) {
                        if(ok) {
                            tid=t;
                            orgSendit1();
                        }
                    });
                };
            }
        }
        else
            tid = topic;
        if( ! subtopic ) stid=0;
        else if(typeof(subtopic) == "string") {
            stid = subtopic2tidT[subtopic];
            if(!stid) {
                var orgSendit2=sendit;
                sendit=function() {
                    self.createsub(subtopic, function(ok,x,t) {
                        if(ok) {
                            stid=t;
                            orgSendit2();
                        }
                    });
                };
            }
        }
        else
            stid=subtopic;
        sendit();
    };

    self.pubjson=function(value,topic,subtopic) {
        self.publish(JSON.stringify(value),topic,subtopic);
    };

    self.topic2tid=function(topic) {
        return topic2tidT[topic];
    };
    
    self.tid2topic=function(tid) {
        return tid2topicT[tid];
    };

    self.subtopic2tid=function(subtopic) {
        return subtopic2tidT[subtopic];
    };
    
    self.tid2subtopic=function(tid) {
        return tid2subtopicT[tid];
    };
    
    self.disconnect=function() {
        if(connected) {
            var d = new Uint8Array(1);
            d[0] = MSG_DISCONNECT
            socket.send(d.buffer);
            connected=false;
        }
    };

    self.subscribe = function(topic, subtopic, settings) {
        subOrCreate(topic, subtopic, settings, false);
    };

    self.create = function(topic, subtopic, onack) {
        if(arguments.length == 3)
            subOrCreate(topic, subtopic, {onack: onack}, true);
        else
            subOrCreate(topic, 0, {onack: subtopic}, true);
    };

    self.createsub = function(subtopic, onsuback) {
        if( ! connected ) {
            pendingCmds.push(function() {
                self.createsub(subtopic, onsuback);
            });
            return;
        }
        if( ! onsuback ) onsuback=function(){};
        if(subtopic2tidT[subtopic])
            onsuback(true, subtopic, subtopic2tidT[subtopic]);
        else {
            if(typeof subtopic == "number") {
                subtopic2tidT[subtopic]=subtopic;
                tid2subtopicT[subtopic]=subtopic;
                onsuback(true, subtopic, subtopic);
            }
            else if(typeof subtopic == "string") {
                if(pushElem(subtopicAckCBT,subtopic,onsuback)) {
                    var d = new Uint8Array(SMQ.utf8.length(subtopic)+1)
                    d[0] = MSG_CREATESUB;
                    SMQ.utf8.encode(subtopic,d,1);
                    socksend(d.buffer);
                }
            }
            else
                throw new Error("Invalid subtopic type");
        }
    };

    var sendMsgWithTid=function(msgType, tid) {
        var d = new Uint8Array(5);
        d[0] = msgType;
        h2n32(tid,d,1);
        socksend(d.buffer);
    };

    self.unsubscribe = function(topic) {
        var tid=getTid(topic);
        if(onMsgCBT[tid]) {
            onMsgCBT[tid]=null;
            sendMsgWithTid(MSG_UNSUBSCRIBE, tid);
        }
    };

    self.observe=function(topic, onchange) {
        var tid=getTid(topic);
        if(tid != selfTid && !observeT[tid]) {
            observeT[tid] = onchange;
            sendMsgWithTid(MSG_OBSERVE, tid);
        }
    };

    self.unobserve=function(topic) {
        var tid=getTid(topic);
        if(observeT[tid]) {
            observeT[tid]=0;
            sendMsgWithTid(MSG_UNOBSERVE, tid);
        }
    };

    self.gettid = function() { return selfTid; }
    self.getsock = function() { return socket; }

    self.onmsg = function(data, ptid, tid, subtid) {
        console.log("Dropping msg: tid=",tid,", ptid=",ptid,", subtid=",subtid);
    };

    createSock(false);

};

var PayTec = {};

PayTec.POSTerminal = function(pairingInfo, options) {
    if (!(this instanceof PayTec.POSTerminal)) return new PayTec.POSTerminal(pairingInfo, options);

    // public API
    this.pair = pair;
    this.unpair = unpair;
    this.connect = connect;
    this.disconnect = disconnect;
    this.activate = activate;
    this.deactivate = deactivate;
    this.startTransaction = startTransaction;
    this.abortTransaction = abortTransaction;
    this.confirmTransaction = confirmTransaction;
    this.rollbackTransaction = rollbackTransaction;
    this.balance = balance;
    this.configure = configure;
    this.initialize = initialize;
    this.requestReceipt = requestReceipt;
    this.print = print;
    this.deviceCommand = deviceCommand;
    this.sendMessage = sendMessage; // for not yet API-ed use cases
    this.needsAmount = needsAmount;
    this.needsAcqID = needsAcqID;
    this.supportsAcqID = supportsAcqID;
    this.needsAmtAuth = needsAmount;
    this.needsAmtOther = needsAmtOther;
    this.needsAuthC = needsAuthC;
    this.needsTrxRefNum = needsTrxRefNum;
    this.supportsTrxRefNum = supportsTrxRefNum;
    this.supportsTrxReasonC = supportsTrxReasonC;
    this.supportsUnsolicitedReceipts = supportsUnsolicitedReceipts;
    this.hasPairing = hasPairing;
    this.getPairingInfo = getPairingInfo;
    this.getSerialNumber = getSerialNumber;
    this.getTerminalID = getTerminalID;
    this.getDeviceModelName = getDeviceModelName;
    this.getSoftwareVersion = getSoftwareVersion;
    this.getStatus = getStatus;
    this.getActSeqCnt = getActSeqCnt;
    this.getPeSeqCnt = getPeSeqCnt;
    this.canPerformTransactions = canPerformTransactions;
    this.getAcquirers = getAcquirers;
    this.getAcquirerInfo = getAcquirerInfo;
    this.getBrands = getBrands;
    this.getCurrencies = getCurrencies;
    this.getTransactionFunctions = getTransactionFunctions;
    this.getTransactionFunctionName = getTransactionFunctionName;

    this.setPeerURL = getPeerURL;
    this.setPeerURL = setPeerURL;

    this.getPOSID = getPOSID;
    this.setPOSID = setPOSID;

    this.getTrmLng = getTrmLng;
    this.setTrmLng = setTrmLng;

    this.getPrinterWidth = getPrinterWidth;
    this.setPrinterWidth = setPrinterWidth;

    this.getAutoConnect = getAutoConnect;
    this.setAutoConnect = setAutoConnect;

    this.getAutoReconnect = getAutoReconnect;
    this.setAutoReconnect = setAutoReconnect;

    this.getAutoConfirm = getAutoConfirm;
    this.setAutoConfirm = setAutoConfirm;

    this.getAddTrxReceiptsToConfirmation = getAddTrxReceiptsToConfirmation;
    this.setAddTrxReceiptsToConfirmation = setAddTrxReceiptsToConfirmation;

    this.getHeartbeatInterval = getHeartbeatInterval;
    this.setHeartbeatInterval = setHeartbeatInterval;

    this.getHeartbeatTimeout = getHeartbeatTimeout;
    this.setHeartbeatTimeout = setHeartbeatTimeout;

    this.getConnectionTimeout = getConnectionTimeout;
    this.setConnectionTimeout = setConnectionTimeout;

    this.getInitializationTimeout = getInitializationTimeout;
    this.setInitializationTimeout = setInitializationTimeout;

    this.getTransactionTimeout = getTransactionTimeout;
    this.setTransactionTimeout = setTransactionTimeout;

    this.getDefaultTimeout = getDefaultTimeout;
    this.setDefaultTimeout = setDefaultTimeout;
    this.setOnPairingSucceeded = setOnPairingSucceeded;
    this.setOnPairingFailed = setOnPairingFailed;
    this.setOnConnected = setOnConnected;

    this.setOnActivationSucceeded = setOnActivationSucceeded;
    this.setOnActivationFailed = setOnActivationFailed;
    this.setOnActivationTimedOut = setOnActivationTimedOut;

    this.setOnDeactivationSucceeded = setOnDeactivationSucceeded;
    this.setOnDeactivationFailed = setOnDeactivationFailed;
    this.setOnDeactivationTimedOut = setOnDeactivationTimedOut;

    this.setOnTransactionApproved = setOnTransactionApproved;
    this.setOnTransactionDeclined = setOnTransactionDeclined;
    this.setOnTransactionReferred = setOnTransactionReferred;
    this.setOnTransactionAborted = setOnTransactionAborted;
    this.setOnTransactionTimedOut = setOnTransactionTimedOut;

    this.setOnTransactionConfirmationSucceeded = setOnTransactionConfirmationSucceeded;
    this.setOnTransactionConfirmationFailed = setOnTransactionConfirmationFailed;
    this.setOnTransactionConfirmationTimedOut = setOnTransactionConfirmationTimedOut;

    this.setOnBalanceSucceeded = setOnBalanceSucceeded;
    this.setOnBalanceFailed = setOnBalanceFailed;
    this.setOnBalanceTimedOut = setOnBalanceTimedOut;

    this.setOnConfigurationSucceeded = setOnConfigurationSucceeded;
    this.setOnConfigurationFailed = setOnConfigurationFailed;
    this.setOnConfigurationTimedOut = setOnConfigurationTimedOut;

    this.setOnInitializationSucceeded = setOnInitializationSucceeded;
    this.setOnInitializationFailed = setOnInitializationFailed;
    this.setOnInitializationTimedOut = setOnInitializationTimedOut;

    this.setOnDeviceCommandSucceeded = setOnDeviceCommandSucceeded;
    this.setOnDeviceCommandFailed = setOnDeviceCommandFailed;
    this.setOnDeviceCommandTimedOut = setOnDeviceCommandTimedOut;

    this.setOnStatusChanged = setOnStatusChanged;
    this.setOnReceipt = setOnReceipt;
    this.setOnMessageSent = setOnMessageSent;

    // must return false if API should process the message
    this.setOnMessageReceived = setOnMessageReceived;
    this.setOnDisconnected = setOnDisconnected;
    this.setOnError = setOnError;

    // symbolic constants
    this.TransactionFunctions = {
        PURCHASE:                       0x00008000,
        PURCHASE_RESERVATION:           0x00004000,
        TIP:                            0x00002000,
        CASH_ADVANCE:                   0x00001000,
        CREDIT:                         0x00000800,
        PURCHASE_PHONE_AUTH:            0x00000400,
        PURCHASE_FORCED_ACCEPTANCE:     0x00000200,
        PURCHASE_PHONE_ORDERED:         0x00000100,
        AUTHORIZATION_PURCHASE:         0x00000080,
        PURCHASE_MAIL_ORDERED:          0x00000040,
        REVERSAL:                       0x00000020,
        RESERVATION:                    0x00000010,
        RESERVATION_ADJUSTMENT:         0x00000008,
        CONFIRM_PHONE_AUTH_RESERVATION: 0x00000004,
        PURCHASE_WITH_CASHBACK:         0x00000001,
        GIRO:                           0x00100000,
        COMBINED:                       0x00080000,
        DEPOSIT:                        0x00040000,
        BALANCE_INQUIRY:                0x00020000,
        CLIENT_ID_REQUEST:              0x00010000,
        AUTHORIZATION_DEPOSIT:          0x00200000,
        AUTHORIZATION_CREDIT:           0x00400000,
        ACTIVATE_CARD:                  0x00800000,
        LOAD:                           0x01000000,
        CANCEL_RESERVATION:             0x02000000,
        ACCOUNT_VERIFICATION:           0x04000000
    };

    this.TransactionRequestFlags = {
        TRX_SILENT:                     0x00000001,
        TRX_REPORT_UNKNOWN_NFC_UID:     0x00000004
    };

    this.TransactionAbortFlags = {
        ABORT_TRX_SILENT: 0x00000001
    };

    this.ReceiptTypes = {
        TRX:                    1,
        TRX_COPY:               2,
        ACTIVATION:             11,
        ACTIVATION_FAILED:      12,
        DEACTIVATION:           13,
        DEACTIVATION_FAILED:    14,
        FINAL_BALANCE:          21,
        FINAL_BALANCE_FAILED:   22,
        CONFIG:                 41,
        INIT:                   43
    };

    this.ReceiptFlags = {
        MORE_DATA_AVAILABLE:    0x00000001,
        FIRST_PART:             0x00000002,
        DOUBLE_HEIGHT:          0x00000004,
        DOUBLE_WIDTH:           0x00000008,
        INVERSE:                0x00000010,
        IS_PNG_IMAGE:           0x00000020
    };

    this.StatusFlags = {
        SHIFT_OPEN:                         0x00000001,
        CARD_DATA_AVAILABLE:                0x00000002,
        BUSY:                               0x00000004,
        READER_SLOT_OCCUPIED:               0x00000008,
        LOCKED:                             0x00000010,
        APPLICATION_SELECTED:               0x00000020,
        WAITING_FOR_TRANSACTION_REQUEST:    0x00000040,
        WAITING_FOR_APPLICATION_SELECTION:  0x00000080,
        ONLINE_PROCESSING:                  0x00000100,
        PRINTER_UNAVAILABLE:                0x00000200,
        OUT_OF_PAPER:                       0x00000400,

        // C4 specific
        MODEM_IN_USE:                       0x40000000
    };

    this.DeviceCommands = {
        EJECT_CARD: 1,
        EJECT_CARD_FORCED: 2,
        REBOOT: 501,
        SW_UPDATE: 502,
        START_REMOTE_MAINTENANCE: 511,
        ENABLE_LANGUAGE_SELECTION: 1001,
        DISABLE_LANGUAGE_SELECTION: 1002,
        SHOW_IDLE: 2001,
        SHOW_CARD_INSERTION: 2002,
        CONFIGURE_DISCONNECTED_TEXT: 2501,
        SCAN_SYMBOL: 2601
    };


    // implementation
    var State = {
        DISCONNECTED: 0,
        PAIRING: 1,
        CONNECTING: 2,
        CONNECTED: 3,
        ACTIVATE: 4,
        DEACTIVATE: 5,
        TRANSACTION: 6,
        AUTHORIZATION_PURCHASE: 7,
        TRX_CONFIRMATION: 8,
        TRX_CONFIRMATION_WAIT_RECEIPTS: 9,
        BALANCE: 10,
        CONFIG: 11,
        INIT: 12,
        DEVICE_COMMAND: 13
    };

    var self = this;
    var state = State.DISCONNECTED;
    var pairing = pairingInfo;
    var serialNumber = undefined;
    var terminalID = undefined;
    var softwareVersion = 0;
    var peerURL = (undefined !== options && undefined !== options.PeerURL) ? options.PeerURL : undefined;
    var posID = (undefined !== options && undefined !== options.POSID) ? options.POSID : undefined;
    var trmLng = (undefined !== options && undefined !== options.TrmLng) ? options.TrmLng : undefined;
    var printerWidth = (undefined !== options && undefined !== options.PrinterWidth) ? options.PrinterWidth : 34;
    var autoConnect = (undefined !== options && undefined !== options.AutoConnect) ? (options.AutoConnect ? true : false) : true;
    var autoReconnect = (undefined !== options && undefined !== options.AutoReconnect) ? (options.AutoReconnect ? true : false) : true;
    var autoConfirm = (undefined !== options && undefined !== options.AutoConfirm) ? (options.AutoConfirm ? true : false) : true;
    var addTrxReceiptsToConfirmation = (undefined !== options && undefined !== options.AddTrxReceiptsToConfirmation) ? (options.AddTrxReceiptsToConfirmation ? true : false) : false;
    var heartbeatInterval = (undefined !== options && undefined !== options.HeartbeatInterval) ? options.HeartbeatInterval : 10000;
    var heartbeatTimeout = (undefined !== options && undefined !== options.HeartbeatTimeout) ? options.HeartbeatTimeout : 10000;
    var connectionTimeout = (undefined !== options && undefined !== options.ConnectionTimeout) ? options.ConnectionTimeout : 20000;
    var initializationTimeout = (undefined !== options && undefined !== options.InitializationTimeout) ? options.InitializationTimeout : 120000;
    var transactionTimeout = (undefined !== options && undefined !== options.TransactionTimeout) ? options.TransactionTimeout : 70000;
    var defaultTimeout = (undefined !== options && undefined !== options.DefaultTimeout) ? options.DefaultTimeout : 30000;
    var onPairingSucceeded = (undefined !== options && undefined !== options.OnPairingSucceeded) ? options.OnPairingSucceeded : myOnPairingSucceeded;
    var onPairingFailed = (undefined !== options && undefined !== options.OnPairingFailed) ? options.OnPairingFailed : myOnPairingFailed;
    var onConnected = (undefined !== options && undefined !== options.OnConnected) ? options.OnConnected : myOnConnected;
    var onDisconnected = (undefined !== options && undefined !== options.OnDisconnected) ? options.OnDisconnected : myOnDisconnected;

    var onActivationSucceeded = (undefined !== options && undefined !== options.OnActivationSucceeded) ? options.OnActivationSucceeded : myOnActivationSucceeded;
    var onActivationFailed = (undefined !== options && undefined !== options.OnActivationFailed) ? options.OnActivationFailed : myOnActivationFailed;
    var onActivationTimedOut = (undefined !== options && undefined !== options.OnActivationTimedOut) ? options.OnActivationTimedOut : myOnActivationTimedOut;

    var onDeactivationSucceeded = (undefined !== options && undefined !== options.OnDeactivationSucceeded) ? options.OnDeactivationSucceeded : myOnDeactivationSucceeded;
    var onDeactivationFailed = (undefined !== options && undefined !== options.OnDeactivationFailed) ? options.OnDeactivationFailed : myOnDeactivationFailed;
    var onDeactivationTimedOut = (undefined !== options && undefined !== options.OnDeactivationTimedOut) ? options.OnDeactivationTimedOut : myOnDeactivationTimedOut;

    var onTransactionApproved = (undefined !== options && undefined !== options.OnTransactionApproved) ? options.OnTransactionApproved : myOnTransactionApproved;
    var onTransactionDeclined = (undefined !== options && undefined !== options.OnTransactionDeclined) ? options.OnTransactionDeclined : myOnTransactionDeclined;
    var onTransactionReferred = (undefined !== options && undefined !== options.OnTransactionReferred) ? options.OnTransactionReferred : myOnTransactionReferred;
    var onTransactionAborted = (undefined !== options && undefined !== options.OnTransactionAborted) ? options.OnTransactionAborted : myOnTransactionAborted;
    var onTransactionTimedOut = (undefined !== options && undefined !== options.OnTransactionTimedOut) ? options.OnTransactionTimedOut : myOnTransactionTimedOut;

    var onTransactionConfirmationSucceeded = (undefined !== options && undefined !== options.OnTransactionConfirmationSucceeded) ? options.OnTransactionConfirmationSucceeded : myOnTransactionConfirmationSucceeded;
    var onTransactionConfirmationFailed = (undefined !== options && undefined !== options.OnTransactionConfirmationFailed) ? options.OnTransactionConfirmationFailed : myOnTransactionConfirmationFailed;
    var onTransactionConfirmationTimedOut = (undefined !== options && undefined !== options.OnTransactionConfirmationTimedOut) ? options.OnTransactionConfirmationTimedOut : myOnTransactionConfirmationTimedOut;

    var onBalanceSucceeded = (undefined !== options && undefined !== options.OnBalanceSucceeded) ? options.OnBalanceSucceeded : myOnBalanceSucceeded;
    var onBalanceFailed = (undefined !== options && undefined !== options.OnBalanceFailed) ? options.OnBalanceFailed : myOnBalanceFailed;
    var onBalanceTimedOut = (undefined !== options && undefined !== options.OnBalanceTimedOut) ? options.OnBalanceTimedOut : myOnBalanceTimedOut;

    var onConfigurationSucceeded = (undefined !== options && undefined !== options.OnConfigurationSucceeded) ? options.OnConfigurationSucceeded : myOnConfigurationSucceeded;
    var onConfigurationFailed = (undefined !== options && undefined !== options.OnConfigurationFailed) ? options.OnConfigurationFailed : myOnConfigurationFailed;
    var onConfigurationTimedOut = (undefined !== options && undefined !== options.OnConfigurationTimedOut) ? options.OnConfigurationTimedOut : myOnConfigurationTimedOut;

    var onInitializationSucceeded = (undefined !== options && undefined !== options.OnInitializationSucceeded) ? options.OnInitializationSucceeded : myOnInitializationSucceeded;
    var onInitializationFailed = (undefined !== options && undefined !== options.OnInitializationFailed) ? options.OnInitializationFailed : myOnInitializationFailed;
    var onInitializationTimedOut = (undefined !== options && undefined !== options.OnInitializationTimedOut) ? options.OnInitializationTimedOut : myOnInitializationTimedOut;

    var onDeviceCommandSucceeded = (undefined !== options && undefined !== options.OnDeviceCommandSucceeded) ? options.OnDeviceCommandSucceeded : myOnDeviceCommandSucceeded;
    var onDeviceCommandFailed = (undefined !== options && undefined !== options.OnDeviceCommandFailed) ? options.OnDeviceCommandFailed : myOnDeviceCommandFailed;
    var onDeviceCommandTimedOut = (undefined !== options && undefined !== options.OnDeviceCommandTimedOut) ? options.OnDeviceCommandTimedOut : myOnDeviceCommandTimedOut;

    var onStatusChanged = (undefined !== options && undefined !== options.OnStatusChanged) ? options.OnStatusChanged : myOnStatusChanged;
    var onReceipt = (undefined !== options && undefined !== options.OnReceipt) ? options.OnReceipt : myOnReceipt;
    var onMessageSent = (undefined !== options && undefined !== options.OnMessageSent) ? options.OnMessageSent : myOnMessageSent;
    var onMessageReceived = (undefined !== options && undefined !== options.OnMessageReceived) ? options.OnMessageReceived : myOnMessageReceived;
    var onError = (undefined !== options && undefined !== options.OnError) ? options.OnError : myOnError;
    var lastStatusResponse = {};
    var trmStatus = 0;
    var setAcqInfo = [];
    var brands = [];
    var currencies = [];
    var trxFunctions = [];
    var actSeqCnt = undefined;
    var peSeqCnt = undefined;
    var confirmingTrxSeqCnt = undefined;
    var transactionReceipts = [];
    var currentAcqID = -1;
    var neverActivated = true;
    var needsActivation = true;
    var scheduleActivationTimer = 0;
    var receiptText = "";
    var localSocket = undefined;
    var localSocketFragment = "";
    var smq = undefined;
    var peerPTID = 0;
    var timer = undefined;
    var heartbeatTimer = undefined;

    createSMQ();

    if (autoConnect)
        setTimeout(connect, 1);

    function pair(code, friendlyName, params) {
        unpair();

        pairing = {
            Code: code.substring(4),
            Channel: generateUUID(),
            PeerName: friendlyName
        };

        if (undefined !== params) {
            for (var i in params) {
                pairing[i] = params[i];
            }
        }

        smq.publish(JSON.stringify({ Pairing: pairing}), code.substring(0, 4));
        smq.subscribe(pairing.Channel, undefined, { "datatype": "json", "onmsg": onMessage } );

        peerURL = undefined;
        changeState(State.PAIRING);
    }

    function unpair() {
        if (hasPairing() && (smq !== undefined)) {
            try {
                smq.unsubscribe(pairing.Channel);
            }
            catch (e) {
                console.log(e);
            }
        }

        pairing = undefined;
        changeState(State.DISCONNECTED);
    }

    function connect() {
        switch (state) {
        case State.DISCONNECTED:
            break;
        default:
            return;
        }

        if (smq === undefined)
            createSMQ();

        if (hasPairing() && (smq !== undefined)) {
            smq.subscribe(pairing.Channel, undefined, { datatype: "json", onmsg: onMessage } );
            changeState(State.CONNECTING);
        }
        else if ((navigator !== undefined)
            && (navigator.userAgent !== undefined)
            && (navigator.userAgent.includes ('wv') || (peerURL !== undefined))) {
            let webSocketURL = (peerURL !== undefined ? peerURL : "ws://localhost:18307");

            console.log("Trying direct web socket connection at " + webSocketURL);

            try {
                localSocket = new WebSocket(webSocketURL);
                localSocket.binaryType = 'arraybuffer';
                changeState(State.CONNECTING);

                localSocket.onmessage = function(evt) {
                    var text = localSocketFragment + new TextDecoder().decode(evt.data);

                    if (text.endsWith("\n")) {
                        localSocketFragment = "";
                        
                        text.split("\n").forEach(function (value, index, array) {
                            if (value.length > 0) {
                                onMessage(JSON.parse(value), null, null, null);
                            }
                        });
                    }
                    else {
                        localSocketFragment = text;
                    }
                };

                localSocket.onopen = function() {
                    sendConnectRequest();
                    sendMessage({ StatusRequest: {}});
                };

                localSocket.onclose = function() {
                    console.log("WebSocket close event");
                    disconnect();
                };

                localSocket.onerror = function(evt) {
                    console.log("WebSocket error: ", event);
                    disconnect();
                };
            }
            catch (e) {
                console.log(e);
                localSocket = undefined;
            }
        }
    }

    function disconnect() {
        if (hasPairing() && (smq !== undefined)) {
            try {
                smq.unsubscribe(pairing.Channel);
            }
            catch (e) {
                console.log(e);
            }
        }
        
        if (localSocket !== undefined) {
            try {
                localSocket.close();
            }
            catch (e) {
                console.log(e);
            }

            localSocket = undefined;
        }

        changeState(State.DISCONNECTED);
    }

    function activate() {
        sendMessage({ ActivationRequest: {}});
        changeState(State.ACTIVATE);
    }

    function deactivate() {
        sendMessage({ DeactivationRequest: {}});
        changeState(State.DEACTIVATE);
    }

    function startTransaction(params) {
        var req = {
        };

        if (undefined !== params) {
            for (var i in params) {
                req[i] = params[i];
            }
        }

        sendMessage({ TransactionRequest: req });

        if ((undefined !== req.TrxFunction) && (self.TransactionFunctions.AUTHORIZATION_PURCHASE == req.TrxFunction)) {
            changeState(State.AUTHORIZATION_PURCHASE);
        }
        else {
            changeState(State.TRANSACTION);
        }
    }

    function abortTransaction(params) {
        var req = {};

        if (undefined !== params) {
            for (var i in params) {
                req[i] = params[i];
            }
        }

        sendMessage({ AbortTransactionRequest: req });
    }

    function confirmTransaction(params) {
        var req = {
            Confirm: 1
        };

        if (undefined !== params) {
            for (var i in params) {
                req[i] = params[i];
            }
        }

        sendMessage({ TransactionConfirmationRequest: req });

        confirmingTrxSeqCnt = req.TrxSeqCnt;
        changeState(State.TRX_CONFIRMATION);
    }

    function rollbackTransaction(params) {
        var req = {
            Confirm: 0
        };

        if (undefined !== params) {
            for (var i in params) {
                req[i] = params[i];
            }
        }

        sendMessage({ TransactionConfirmationRequest: req });
        changeState(State.CONNECTED);
    }

    function balance(params) {
        var req = {
        };

        if (undefined !== params) {
            for (var i in params) {
                req[i] = params[i];
            }
        }

        switch (state) {
        case State.CONNECTED:
            sendMessage({ BalanceRequest: req });
            changeState(State.BALANCE);
            break;
        case State.DISCONNECTED:
        case State.PAIRING:
            onError("API not connected");
            break;
        default:
            // let the terminal generate an approriate error message
            sendMessage({ BalanceRequest: req });
        }
    }

    function configure(params) {
        var req = {
        };

        if (undefined !== params) {
            for (var i in params) {
                req[i] = params[i];
            }
        }

        switch (state) {
        case State.CONNECTED:
            sendMessage({ ConfigurationRequest: req });
            changeState(State.CONFIG);
            break;
        case State.DISCONNECTED:
        case State.PAIRING:
            onError("API not connected");
            break;
        default:
            // let the terminal generate an approriate error message
            sendMessage({ ConfigurationRequest: req });
        }
    }

    function initialize(acqID, params) {
        var req = {
            "AcqID": acqID
        };

        if (undefined !== params) {
            for (var i in params) {
                req[i] = params[i];
            }
        }

        switch (state) {
        case State.CONNECTED:
            sendMessage({ InitializationRequest: req});
            currentAcqID = acqID;
            changeState(State.INIT);
            break;
        case State.DISCONNECTED:
        case State.PAIRING:
            onError("API not connected");
            break;
        default:
            // let the terminal generate an approriate error message
            sendMessage({ InitializationRequest: req});
        }
    }

    function requestReceipt(params) {
        var req = {
        };

        if (undefined !== params) {
            for (var i in params) {
                if (i == "ReceiptID") {
                    req.ReceiptIDNumeric = parseInt(params[i]);
                }
                else {
                    req[i] = params[i];
                }
            }
        }

        sendMessage({ ReceiptRequest: req});
    }

    function requestReceiptIfNecessary(params) {
        if (!supportsUnsolicitedReceipts()) {
            var req = {
            };

            if (undefined !== params) {
                for (var i in params) {
                    if (i == "ReceiptID") {
                        req.ReceiptIDNumeric = parseInt(params[i]);
                    }
                    else {
                        req[i] = params[i];
                    }
                }
            }

            sendMessage({ ReceiptRequest: req});
        }
    }

    function print(params) {
        var req = {
        };

        if (undefined !== params) {
            for (var i in params) {
                req[i] = params[i];
            }
        }

        sendMessage({ PrintReceiptRequest: req });
    }

    function deviceCommand(params) {
        var req = {};

        if (undefined !== params) {
            for (var i in params) {
                req[i] = params[i];
            }
        }

        switch (state) {
        case State.CONNECTED:
            sendMessage({ DeviceCommandRequest: req });
            changeState(State.DEVICE_COMMAND);
            break;
        case State.DISCONNECTED:
        case State.PAIRING:
            onError("API not connected");
            break;
        default:
            sendMessage({ DeviceCommandRequest: req });
        }
    }

    function sendMessage(message) {
        if (localSocket !== undefined) {
            localSocket.send(new TextEncoder().encode(JSON.stringify(message) + "\n"));
            onMessageSent(message);
        }
        else if (smq !== undefined) {
            smq.publish(JSON.stringify(message), peerPTID);
            onMessageSent(message, peerPTID);
        }
    }

    function needsAmount(trxFunction) {
        switch (parseInt(trxFunction)) {
        case self.TransactionFunctions.REVERSAL:
        case self.TransactionFunctions.BALANCE_INQUIRY:
        case self.TransactionFunctions.CLIENT_ID_REQUEST:
        case self.TransactionFunctions.ACTIVATE_CARD:
        case self.TransactionFunctions.CANCEL_RESERVATION:
        case self.TransactionFunctions.ACCOUNT_VERIFICATION:
            return false;
        default:
            return true;
        }
    }

    function needsAcqID(trxFunction) {
        return needsTrxRefNum(trxFunction);
    }

    function supportsAcqID(trxFunction) {
        return supportsTrxRefNum(trxFunction);
    }

    function needsAmtOther(trxFunction) {
        switch (parseInt(trxFunction)) {
        case self.TransactionFunctions.PURCHASE_WITH_CASHBACK:
            return true;
        default:
            return false;
        }
    }

    function needsAuthC(trxFunction) {
        switch (parseInt(trxFunction)) {
        case self.TransactionFunctions.PURCHASE_PHONE_AUTH:
            return true;
        default:
            return false;
        }
    }

    function needsTrxRefNum(trxFunction) {
        switch (parseInt(trxFunction)) {
        case self.TransactionFunctions.PURCHASE_RESERVATION:
        case self.TransactionFunctions.RESERVATION_ADJUSTMENT:
        case self.TransactionFunctions.CONFIRM_PHONE_AUTH_RESERVATION:
        case self.TransactionFunctions.CANCEL_RESERVATION:
            return true;
        default:
            return false;
        }
    }
    
    function supportsTrxRefNum(trxFunction) {
        if (needsTrxRefNum(trxFunction)) {
            return true;
        }

        switch (parseInt(trxFunction)) {
        case self.TransactionFunctions.PURCHASE:
        case self.TransactionFunctions.CREDIT:
            return (getSoftwareVersion() >= 191000);
        default:
            return false;
        }
    }

    function supportsTrxReasonC(trxFunction) {
        switch (parseInt(trxFunction)) {
        case self.TransactionFunctions.ACCOUNT_VERIFICATION:
            return true;
        default:
            return false;
        }
    }

    function hasPairing() {
        return (pairing !== undefined) && pairing && (pairing.Channel);
    }

    function supportsUnsolicitedReceipts() {
        return (getSoftwareVersion() >= 170005);
    }

    function getPairingInfo() {
        return pairing;
    }

    function getSerialNumber() {
        return serialNumber;
    }

    function getTerminalID() {
        return terminalID;
    }

    function getDeviceModelName() {
        return deviceModelNameFromSerialNumber(serialNumber);
    }

    function getSoftwareVersion() {
        return softwareVersion;
    }

    function getStatus() {
        return trmStatus;
    }

    function getActSeqCnt() {
        return actSeqCnt;
    }

    function getPeSeqCnt() {
        return peSeqCnt;
    }

    function canPerformTransactions() {
        return (0 != (trmStatus & self.StatusFlags.SHIFT_OPEN))
                && (0 == (trmStatus & (self.StatusFlags.BUSY | self.StatusFlags.LOCKED)));
    }

    function getAcquirers() {
        var acquirers = [];

        for (var i in setAcqInfo) {
            var acqInfo = setAcqInfo[i];
            acquirers.push(acqInfo.AcqID);
        }

        return acquirers;
    }

    function getAcquirerInfo(acqID) {
        for (var i in setAcqInfo) {
            var acqInfo = setAcqInfo[i];

            if (acqID == acqInfo.AcqID) {
                return JSON.parse(JSON.stringify(acqInfo));
            }
        }

        return undefined;
    }

    function getBrands() {
        return JSON.parse(JSON.stringify(brands));
    }

    function getCurrencies() {
        return JSON.parse(JSON.stringify(currencies));
    }

    function getTransactionFunctions() {
        return JSON.parse(JSON.stringify(trxFunctions));
    }

    function getTransactionFunctionName(trxFunction, language) {
        var names = {};
        names[self.TransactionFunctions.PURCHASE]                         = { en: "Purchase",                   de: "Buchung",                  fr: "Vente",                    it: "Transazione" };
        names[self.TransactionFunctions.PURCHASE_RESERVATION]             = { en: "Purchase Reservation",       de: "Buchung Reservation",      fr: "Vente Réservation",        it: "Vendita Riservazione" };
        names[self.TransactionFunctions.CASH_ADVANCE]                     = { en: "Cash Advance",               de: "Bargeldbezug",             fr: "Retrait en Espèces",       it: "Acquisto Contanti" };
        names[self.TransactionFunctions.CREDIT]                           = { en: "Credit",                     de: "Gutschrift",               fr: "Crédit",                   it: "Credito" };
        names[self.TransactionFunctions.PURCHASE_PHONE_AUTH]              = { en: "Phone Authorised",           de: "Tel. autorisiert",         fr: "Autorisation Téléph.",     it: "Autorizzazione Tel." };
        names[self.TransactionFunctions.PURCHASE_FORCED_ACCEPTANCE]       = { en: "Purchase merchant accep.",   de: "Buchung Händler akzept.",  fr: "Vente commercant accept.", it: "Transaz. rivend accep." };
        names[self.TransactionFunctions.PURCHASE_PHONE_ORDERED]           = { en: "Phone Ordered",              de: "Buchung Phone Order",      fr: "Vente Phone Order",        it: "Vendita Phone Order" };
        names[self.TransactionFunctions.AUTHORIZATION_PURCHASE]           = { en: "Authorisation Purchase",     de: "Buchung Autorisation",     fr: "Vente autoris.",           it: "Venta autorizzione" };
        names[self.TransactionFunctions.PURCHASE_MAIL_ORDERED]            = { en: "Mail Ordered",               de: "Buchung Mail Order",       fr: "Vente Mail Order",         it: "Vendita Mail Order" };
        names[self.TransactionFunctions.REVERSAL]                         = { en: "Reversal",                   de: "Storno",                   fr: "Annulation",               it: "Storno" };
        names[self.TransactionFunctions.RESERVATION]                      = { en: "Reservation",                de: "Reservation",              fr: "Réservation",              it: "Riservazione" };
        names[self.TransactionFunctions.RESERVATION_ADJUSTMENT]           = { en: "Reservation Adj.",           de: "Reservation erhöhen",      fr: "Augment. Réservation",     it: "Aumento Riservazione" };
        names[self.TransactionFunctions.CONFIRM_PHONE_AUTH_RESERVATION]   = { en: "Confirm Reservation",        de: "Reservation bestätigen",   fr: "Confirm. Réservation",     it: "Conf. Riservazione" };
        names[self.TransactionFunctions.PURCHASE_WITH_CASHBACK]           = { en: "Purchase w. Cashback",       de: "Buchung m. Cashback",      fr: "Vente avec Cashback",      it: "Vendita con Cashback" };
        names[self.TransactionFunctions.BALANCE_INQUIRY]                  = { en: "Balance Inquiry",            de: "Saldoabfrage",             fr: "Requête du Solde",         it: "Richiesta Saldo" };
        names[self.TransactionFunctions.ACTIVATE_CARD]                    = { en: "Card Activation",            de: "Karte aktivieren",         fr: "Activation Carte",         it: "Attivazione Carta" };
        names[self.TransactionFunctions.LOAD]                             = { en: "Load",                       de: "Laden",                    fr: "Chargement",               it: "Carica" };
        names[self.TransactionFunctions.CANCEL_RESERVATION]               = { en: "Cancel Reservation",         de: "Storno Reservation",       fr: "Annuler Réservation",      it: "Storno Riservazione" };
        names[self.TransactionFunctions.ACCOUNT_VERIFICATION]             = { en: "Account Verification",       de: "Konto überprüfen",         fr: "Vérification du compte",   it: "Verifica dell’account" };
        var result = "";
        var translations = names[trxFunction];

        if (language === undefined) {
            language = trmLng;
        }

        if (translations !== undefined) {
            if (translations[language] !== undefined) {
                result = translations[language];
            }
            else {
                result = translations["en"];
            }
        }
        
        return result;
    }

    function getPeerURL() {
        return peerURL;
    }

    function setPeerURL(value) {
        peerURL = value;
        return self;
    }

    function getPOSID() {
        return posID;
    }

    function setPOSID(value) {
        posID = value;
        return self;
    }

    function getTrmLng() {
        return trmLng;
    }

    function setTrmLng(value) {
        trmLng = value;
        return self;
    }

    function getPrinterWidth() {
        return printerWidth;
    }

    function setPrinterWidth(value) {
        printerWidth = value;
        return self;
    }

    function getAutoConnect() {
        return autoConnect;
    }

    function setAutoConnect(value) {
        autoConnect = (undefined === value ? false : (value ? true : false));
        return self;
    }

    function getAutoReconnect() {
        return autoReconnect;
    }

    function setAutoReconnect(value) {
        autoReconnect = (undefined === value ? false : (value ? true : false));
        return self;
    }

    function getAutoConfirm() {
        return autoConfirm;
    }

    function setAutoConfirm(value) {
        autoConfirm = (undefined === value ? false : (value ? true : false));
        return self;
    }

    function getAddTrxReceiptsToConfirmation() {
        return addTrxReceiptsToConfirmation;
    }

    function setAddTrxReceiptsToConfirmation(value) {
        addTrxReceiptsToConfirmation = (undefined === value ? false : (value ? true : false));
        return self;
    }

    function getHeartbeatInterval() {
        return heartbeatInterval;
    }

    function setHeartbeatInterval(value) {
        heartbeatInterval = parseInt(value);
        return self;
    }

    function getHeartbeatTimeout() {
        return heartbeatTimeout;
    }

    function setHeartbeatTimeout(value) {
        heartbeatTimeout = parseInt(value);
        return self;
    }

    function getConnectionTimeout() {
        return connectionTimeout;
    }

    function setConnectionTimeout(value) {
        connectionTimeout = parseInt(value);
        return self;
    }

    function getInitializationTimeout() {
        return initializationTimeout;
    }

    function setInitializationTimeout(value) {
        initializationTimeout = parseInt(value);
        return self;
    }

    function getTransactionTimeout() {
        return transactionTimeout;
    }

    function setTransactionTimeout(value) {
        transactionTimeout = parseInt(value);
        return self;
    }

    function getDefaultTimeout() {
        return defaultTimeout;
    }

    function setDefaultTimeout(value) {
        defaultTimeout = parseInt(value);
        return self;
    }

    function setOnPairingSucceeded(callback) {
        onPairingSucceeded = callback;
    }

    function myOnPairingSucceeded() {
        console.log("Paired with " + self.getTerminalID() + " (" + self.getSerialNumber() + ")\n");
    }

    function setOnPairingFailed(callback) {
        onPairingFailed = callback;
    }

    function myOnPairingFailed() {
        console.log("Pairing failed\n");
    }

    function setOnConnected(callback) {
        onConnected = callback;
    }

    function myOnConnected() {
        console.log("Connected to " + serialNumber + "\n");
    }

    function setOnDisconnected(callback) {
        onDisconnected = callback;
    }

    function myOnDisconnected() {
        console.log("Disconnected\n");
    }

    function setOnActivationSucceeded(callback) {
        onActivationSucceeded = callback;
    }

    function myOnActivationSucceeded() {
        console.log("Activation succeeded\n");
    }

    function setOnActivationFailed(callback) {
        onActivationFailed = callback;
    }

    function myOnActivationFailed() {
        console.log("Activation failed\n");
    }

    function setOnActivationTimedOut(callback) {
        onActivationTimedOut = callback;
    }

    function myOnActivationTimedOut() {
        console.log("Activation timed out\n");
    }

    function setOnDeactivationSucceeded(callback) {
        onDeactivationSucceeded = callback;
    }

    function myOnDeactivationSucceeded() {
        console.log("Deactivation succeeded\n");
    }

    function setOnDeactivationFailed(callback) {
        onDeactivationFailed = callback;
    }

    function myOnDeactivationFailed() {
        console.log("Deactivation failed\n");
    }

    function setOnDeactivationTimedOut(callback) {
        onDeactivationTimedOut = callback;
    }

    function myOnDeactivationTimedOut() {
        console.log("Deactivation timed out\n");
    }

    function setOnTransactionApproved(callback) {
        onTransactionApproved = callback;
    }

    function myOnTransactionApproved(response) {
        console.log("Transaction approved\n");
        console.dir(response);
    }

    function setOnTransactionDeclined(callback) {
        onTransactionDeclined = callback;
    }

    function myOnTransactionDeclined(response) {
        console.log("Transaction declined\n");
        console.dir(response);
    }

    function setOnTransactionReferred(callback) {
        onTransactionReferred = callback;
    }

    function myOnTransactionReferred(response) {
        console.log("Transaction referred\n");
        console.dir(response);
    }

    function setOnTransactionAborted(callback) {
        onTransactionAborted = callback;
    }

    function myOnTransactionAborted(response) {
        console.log("Transaction aborted\n");
        console.dir(response);
    }

    function setOnTransactionTimedOut(callback) {
        onTransactionTimedOut = callback;
    }

    function myOnTransactionTimedOut(response) {
        console.log("Transaction timed out\n");
        console.dir(response);
    }

    function setOnTransactionConfirmationSucceeded(callback) {
        onTransactionConfirmationSucceeded = callback;
    }

    function myOnTransactionConfirmationSucceeded(response) {
        console.log("Transaction confirmed\n");
        console.dir(response);
    }

    function setOnTransactionConfirmationFailed(callback) {
        onTransactionConfirmationFailed = callback;
    }

    function myOnTransactionConfirmationFailed(response) {
        console.log("Transaction confirmation failed\n");
        console.dir(response);
    }

    function setOnTransactionConfirmationTimedOut(callback) {
        onTransactionConfirmationTimedOut = callback;
    }

    function myOnTransactionConfirmationTimedOut(response) {
        console.log("Transaction confirmation timed out\n");
        console.dir(response);
    }

    function setOnBalanceSucceeded(callback) {
        onBalanceSucceeded = callback;
    }

    function myOnBalanceSucceeded() {
        console.log("Balance succeeded\n");
    }

    function setOnBalanceFailed(callback) {
        onBalanceFailed = callback;
    }

    function myOnBalanceFailed() {
        console.log("Balance failed\n");
    }

    function setOnBalanceTimedOut(callback) {
        onBalanceTimedOut = callback;
    }

    function myOnBalanceTimedOut() {
        console.log("Balance timed out\n");
    }

    function setOnConfigurationSucceeded(callback) {
        onConfigurationSucceeded = callback;
    }

    function myOnConfigurationSucceeded() {
        console.log("Configuration succeeded\n");
    }

    function setOnConfigurationFailed(callback) {
        onConfigurationFailed = callback;
    }

    function myOnConfigurationFailed() {
        console.log("Configuration failed\n");
    }

    function setOnConfigurationTimedOut(callback) {
        onConfigurationTimedOut = callback;
    }

    function myOnConfigurationTimedOut() {
        console.log("Configuration timed out\n");
    }

    function setOnInitializationSucceeded(callback) {
        onInitializationSucceeded = callback;
    }

    function myOnInitializationSucceeded() {
        console.log("Initialization succeeded\n");
    }

    function setOnInitializationFailed(callback) {
        onInitializationFailed = callback;
    }

    function myOnInitializationFailed() {
        console.log("Initialization failed\n");
    }

    function setOnInitializationTimedOut(callback) {
        onInitializationTimedOut = callback;
    }

    function myOnInitializationTimedOut() {
        console.log("Initialization timed out\n");
    }

    function setOnDeviceCommandSucceeded(callback) {
        onDeviceCommandSucceeded = callback;
    }

    function myOnDeviceCommandSucceeded() {
        console.log("DeviceCommand succeeded\n");
    }

    function setOnDeviceCommandFailed(callback) {
        onDeviceCommandFailed = callback;
    }

    function myOnDeviceCommandFailed() {
        console.log("DeviceCommand failed\n");
    }

    function setOnDeviceCommandTimedOut(callback) {
        onDeviceCommandTimedOut = callback;
    }

    function myOnDeviceCommandTimedOut() {
        console.log("DeviceCommand timed out\n");
    }

    function setOnStatusChanged(callback) {
        onStatusChanged = callback;
    }

    function myOnStatusChanged(lastStatusResponse) {
        console.log("New status: " + getStatus() + "\n");
    }

    function setOnReceipt(callback) {
        onReceipt = callback;
    }

    function myOnReceipt(receiptType, receiptText) {
        console.log("Receipt: \n" + receiptText + "\n");
    }

    function setOnMessageSent(callback) {
        onMessageSent = callback;
    }

    function myOnMessageSent(message, peerPTID) {
        if ((peerPTID === undefined) || (peerPTID == null)) {
            console.log(timeStamp() + ">> (" + localSocket.url + ") " + JSON.stringify(message) + "\n");
        }
        else {
            console.log(timeStamp() + ">> " + JSON.stringify(message) + "\n");
        }
    }

    function setOnMessageReceived(callback) {
        onMessageReceived = callback;
    }

    function myOnMessageReceived(message, ptid, tid, subtid) {
        if (tid == null) {
            console.log(timeStamp() + "<< (" + localSocket.url + ") " + JSON.stringify(message) + "\n");
        }
        else {
            console.log(timeStamp() + "<< " + JSON.stringify(message) + "\n");
        }
        return false;
    }

    function setOnError(callback) {
        onError = callback;
    }

    function myOnError(message) {
        console.log("Error: '" + message + "'\n");
    }

    // private methods
    function changeState(newState) {
        console.log(getStateName(state) + " -> " + getStateName(newState) + "\n");
        clearTimer();

        // exit actions
        switch (state) {
        case State.PAIRING:
        case State.CONNECTING:
        case State.TRANSACTION:
        case State.AUTHORIZATION_PURCHASE:
        case State.ACTIVATE:
        case State.DEACTIVATE:
        case State.TRX_CONFIRMATION:
        case State.TRX_CONFIRMATION_WAIT_RECEIPTS:
            break;
        case State.BALANCE:
        case State.CONFIG:
        case State.INIT:
        case State.DEVICE_COMMAND:
        case State.DISCONNECTED:
        case State.CONNECTED:
            break;
        }

        var oldState = state;
        state = newState;

        // entry actions
        switch (state) {
        case State.PAIRING:
        case State.CONNECTING:
            setTimer(connectionTimeout);
            break;
        case State.TRANSACTION:
        case State.AUTHORIZATION_PURCHASE:
            confirmingTrxSeqCnt = undefined;
            setTimer(transactionTimeout);
            break;
        case State.INIT:
            setTimer(initializationTimeout);
            break;
        case State.ACTIVATE:
            needsActivation = false;
            setTimer(defaultTimeout);
            break;
        case State.DEACTIVATE:
        case State.TRX_CONFIRMATION:
            setTimer(defaultTimeout);
            break;
        case State.TRX_CONFIRMATION_WAIT_RECEIPTS:
            transactionReceipts = [];
            setTimer(defaultTimeout);
            break;
        case State.BALANCE:
        case State.CONFIG:
        case State.DEVICE_COMMAND:
            setTimer(defaultTimeout);
            break;
        case State.DISCONNECTED:
            if (peerPTID)
                peerPTID = 0;

            if (state != oldState) {
                try {
                    onDisconnected();
                }
                catch (e) {
                    console.log("Callback failed: " + e + "\n" + e.stack);
                }

                if (autoReconnect) {
                    console.log("Reconnecting in 3 seconds");
                    setTimeout(connect, 3000);
                }
            }

            break;
        case State.CONNECTED:
            localSocketFragment = "";
            break;
        }
    }

    function onMessage(message, ptid, tid, subtid) {
        if (peerPTID && (ptid != peerPTID)) {
            console.log("Ignoring message '" + JSON.stringify(message) + "' from unknown ptid " + ptid + "\n");
            return;
        }

        clearHeartbeatTimer();
        heartbeatTimer = setTimeout(heartbeat, heartbeatInterval);

        peerPTID = ptid;

        try {
            if (onMessageReceived(message, ptid, tid, subtid))
                return; // message already handled by onMessageReceived()
        }
        catch (e) {
            console.log("Callback failed: " + e + "\n" + e.stack);
        }

        if (message.HeartbeatRequest) {
            sendMessage({ HeartbeatResponse: {} });
        }
        else if (message.StatusResponse) {
            onStatusResponse(message.StatusResponse);
        }
        else if (message.ReceiptResponse) {
            onReceiptResponse(message.ReceiptResponse);
        }
        else if (message.ErrorNotification) {
            try {
                onError(message.ErrorNotification.ErrorDescription);
            }
            catch (e) {
                console.log("Callback failed: " + e + "\n" + e.stack);
            }
        }
        else if (message.EFTHello) {
            // triggers ConnectRequest, also in case of SMQ reconnection
            onEFTHello(message.EFTHello);
        }
        else if (message.ConnectResponse) {
            if (undefined !== message.ConnectResponse.TrmLng)
                trmLng = message.ConnectResponse.TrmLng;

            if (undefined !== message.ConnectResponse.IFDSerialNum)
                serialNumber = message.ConnectResponse.IFDSerialNum;

            if (undefined !== message.ConnectResponse.TrmID)
                terminalID = message.ConnectResponse.TrmID;

            if (undefined !== message.ConnectResponse.SoftwareVersion)
                softwareVersion = message.ConnectResponse.SoftwareVersion;

            if (undefined !== message.ConnectResponse.ActSeqCnt)
                actSeqCnt = message.ConnectResponse.ActSeqCnt;

            if (undefined !== message.ConnectResponse.PeSeqCnt)
                peSeqCnt = message.ConnectResponse.PeSeqCnt;
        }
        else if (message.ActivationResponse) {
            if (undefined !== message.ActivationResponse.ActSeqCnt)
                actSeqCnt = message.ActivationResponse.ActSeqCnt;

            if (undefined !== message.ActivationResponse.PeSeqCnt)
                peSeqCnt = message.ActivationResponse.PeSeqCnt;
        }

        switch (state) {
        case State.DISCONNECTED:
            break;
        case State.PAIRING:
            if (message.ErrorNotification) {
                disconnect();
                onPairingFailed();
            }
            else if (message.EFTHello) {
                changeState(State.CONNECTING);
                onPairingSucceeded();
            }
            break;
        case State.CONNECTING:
            if (message.ConnectResponse) {
                changeState(State.CONNECTED);
                onConnected();
            }
            break;
        case State.CONNECTED:
            if (message.ActivationResponse) {
                if (undefined === terminalID)
                    terminalID = message.ActivationResponse.TrmID;

                onActivationResponse(message.ActivationResponse);
                onActivationSucceeded();
            }
            break;
        case State.ACTIVATE:
            if (message.ErrorNotification) {
                changeState(State.CONNECTED);
                onActivationFailed();
            }
            else if (message.ActivationResponse) {
                if (undefined === terminalID)
                    terminalID = message.ActivationResponse.TrmID;

                onActivationResponse(message.ActivationResponse);
                changeState(State.CONNECTED);
                onActivationSucceeded();
            }
            break;
        case State.DEACTIVATE:
            if (message.ErrorNotification) {
                changeState(State.CONNECTED);
                onDeactivationFailed();
            }
            else if (message.DeactivationResponse) {
                requestReceiptIfNecessary({ ReceiptType: self.ReceiptTypes.DEACTIVATION });

                changeState(State.CONNECTED);
                onDeactivationSucceeded();
            }
            break;
        case State.TRANSACTION:
            if (message.ErrorNotification) {
                abortTransaction();
                changeState(State.CONNECTED);
            }
            else if (message.TransactionResponse) {
                let rsp = message.TransactionResponse;

                switch (rsp.TrxResult) {
                case 0:
                    if (autoConfirm) {
                        confirmTransaction();
                    }

                    try {
                        onTransactionApproved(rsp);
                    }
                    catch (e) {
                    }
                    break;
                case 1:
                    onTransactionDeclined(rsp);
                    changeState(State.CONNECTED);
                    break;
                case 2:
                    onTransactionReferred(rsp);
                    changeState(State.CONNECTED);
                    break;
                default:
                    onTransactionAborted(rsp);
                    changeState(State.CONNECTED);
                }
            }
            break;
        case State.AUTHORIZATION_PURCHASE:
            if (message.ErrorNotification) {
                abortTransaction();
            }
            else if (message.TransactionResponse) {
                let rsp = message.TransactionResponse;

                switch (rsp.TrxResult) {
                case 0:
                    try {
                        onTransactionApproved(rsp);
                    }
                    catch (e) {
                    }
                    break;
                case 1:
                    onTransactionDeclined(rsp);
                    break;
                case 2:
                    onTransactionReferred(rsp);
                    break;
                default:
                    onTransactionAborted(rsp);
                }

                changeState(State.CONNECTED);
            }
            break;
        case State.TRX_CONFIRMATION:
            if (message.ErrorNotification) {
                rollbackTransaction();
                onTransactionConfirmationFailed();
            }
            else if (message.TransactionConfirmationResponse) {
                requestReceiptIfNecessary({ ReceiptType: self.ReceiptTypes.TRX, ReceiptID: confirmingTrxSeqCnt });
                
                if (addTrxReceiptsToConfirmation) {
                    changeState(State.TRX_CONFIRMATION_WAIT_RECEIPTS);
                } else {
                    changeState(State.CONNECTED);
                    onTransactionConfirmationSucceeded({});
                }
            }
            break;
        case State.TRX_CONFIRMATION_WAIT_RECEIPTS:
            if (message.ErrorNotification) {
                changeState(State.CONNECTED);

                // transaction is already confirmed at this stage
                onTransactionConfirmationSucceeded({Receipts: transactionReceipts});
            }
            else if (message.ReceiptResponse) {
                if (message.ReceiptResponse.ReceiptType == self.ReceiptTypes.TRX_COPY) {
                    changeState(State.CONNECTED);
                    onTransactionConfirmationSucceeded({Receipts: transactionReceipts});
                }
            }
            break;
        case State.BALANCE:
            if (message.ErrorNotification) {
                changeState(State.CONNECTED);
                onBalanceFailed();
            }
            else if (message.BalanceResponse) {
                requestReceiptIfNecessary({ ReceiptType: self.ReceiptTypes.FINAL_BALANCE });
                changeState(State.CONNECTED);
                onBalanceSucceeded();
            }
            break;
        case State.CONFIG:
            if (message.ErrorNotification) {
                changeState(State.CONNECTED);
                onConfigurationFailed();
            }
            else if (message.ConfigurationResponse) {
                requestReceiptIfNecessary({ ReceiptType: self.ReceiptTypes.CONFIG });
                changeState(State.CONNECTED);
                onConfigurationSucceeded();
            }
            break;
        case State.INIT:
            if (message.ErrorNotification) {
                changeState(State.CONNECTED);
                onInitializationFailed();
            }
            else if (message.InitializationResponse) {
                requestReceiptIfNecessary({ ReceiptType: self.ReceiptTypes.INIT, ReceiptID: currentAcqID });
                changeState(State.CONNECTED);
                onInitializationSucceeded();
            }
            break;
        case State.DEVICE_COMMAND:
            if (message.ErrorNotification) {
                changeState(State.CONNECTED);
                onDeviceCommandFailed();
            }
            if (message.DeviceCommandResponse) {
                changeState(State.CONNECTED);
                onDeviceCommandSucceeded(message.DeviceCommandResponse);
            }
            break;
        }
    }

    function onTimer() {
        switch (state) {
        case State.PAIRING:
            onPairingFailed();
            disconnect();
            break;
        case State.CONNECTING:
            disconnect();
            break;
        case State.TRANSACTION:
        case State.AUTHORIZATION_PURCHASE:
            abortTransaction();
            onTransactionTimedOut();
            changeState(State.CONNECTED);
            break;
        case State.ACTIVATE:
            onActivationTimedOut();
            changeState(State.CONNECTED);
            break;
        case State.DEACTIVATE:
            OnDeactivationTimedOut();
            changeState(State.CONNECTED);
            break;
        case State.TRX_CONFIRMATION:
            onTransactionConfirmationTimedOut();
            changeState(State.CONNECTED);
            break;
        case State.TRX_CONFIRMATION_WAIT_RECEIPTS:
            // transaction already confirmed at this stage
            onTransactionConfirmationSucceeded({Receipts: transactionReceipts});
            changeState(State.CONNECTED);
            break;
        case State.BALANCE:
            onBalanceTimedOut();
            changeState(State.CONNECTED);
            break;
        case State.CONFIG:
            onConfigurationTimedOut();
            changeState(State.CONNECTED);
            break;
        case State.INIT:
            onInitializationTimedOut();
            changeState(State.CONNECTED);
            break;
        case State.DEVICE_COMMAND:
            onDeviceCommandTimedOut();
            changeState(State.CONNECTED);
            break;
        case State.DISCONNECTED:
        case State.CONNECTED:
            break;
        }
    }

    function setTimer(mSec) {
        clearTimer();
        timer = setTimeout(onTimer, mSec);
    }

    function clearTimer() {
        if (undefined !== timer) {
            clearTimeout(timer);
            timer = undefined
        }
    }

    function sendConnectRequest() {
        var connectReq = {
            ConnectRequest: {
                PrinterWidth: printerWidth,
                UnsolicitedReceipts: 1
            }
        };

        if (undefined !== trmLng) {
            connectReq.ConnectRequest.TrmLng = trmLng;
        }

        if (undefined !== posID) {
            connectReq.ConnectRequest.POSID = posID;
        }

        connectReq.POSInterface = "KIT";

        if (localSocket !== undefined) {
            if (peerURL == "ws://localhost:28307") {
                connectReq.POSInterfaceTransport = "Serial";
            }
            else {
                connectReq.POSInterfaceTransport = "Local";
            }
        }
        else {
            connectReq.POSInterfaceTransport = "Cloud";
        }

        sendMessage(connectReq);
    }

    function onStatusResponse(rsp) {
        lastStatusResponse = rsp;
        trmStatus = rsp.TrmStatus;
        setAcqInfo = rsp.SetAcqInfo;

        // if terminal is active, send ActivationRequest to get the brand info etc.
        if ((0 != (trmStatus & self.StatusFlags.SHIFT_OPEN))
                && (0 == (trmStatus & (self.StatusFlags.BUSY | self.StatusFlags.LOCKED)))
                && (neverActivated || needsActivation)) {
            if (scheduleActivationTimer) {
                clearTimeout(scheduleActivationTimer);
                scheduleActivationTimer = 0;
            }

            activate();
        }
        else {
            try {
                onStatusChanged(rsp);
            }
            catch (e) {
                console.log("Callback failed: " + e + "\n" + e.stack);
            }
        }
    }

    function onActivationResponse(rsp) {
        requestReceiptIfNecessary({ ReceiptType: self.ReceiptTypes.ACTIVATION });

        brands = rsp.Brands;
        currencies = rsp.Currencies;
        trxFunctions = [];

        for (var i in self.TransactionFunctions) {
            if (rsp.TrxFunctions & self.TransactionFunctions[i]) {
                trxFunctions.push(self.TransactionFunctions[i]);
            }
        }

        neverActivated = false;

        try {
            onStatusChanged(lastStatusResponse);
        }
        catch (e) {
            console.log("Callback failed: " + e + "\n" + e.stack);
        }
    }

    function onReceiptResponse(rsp) {
        if (rsp.ReceiptFlags & self.ReceiptFlags.FIRST_PART) {
            receiptText = "";
        }
        
        receiptText += rsp.ReceiptText;

        if (rsp.ReceiptFlags & self.ReceiptFlags.MORE_DATA_AVAILABLE) {
            requestReceiptIfNecessary({ ReceiptType: rsp.ReceiptType });
        }
        else {
            onReceipt(rsp.ReceiptType, receiptText);
            
            switch (rsp.ReceiptType) {
            case self.ReceiptTypes.TRX:
            case self.ReceiptTypes.TRX_COPY:
                if (addTrxReceiptsToConfirmation) {
                    transactionReceipts.push(rsp);
                }
                break;
            case self.ReceiptTypes.CONFIG:
            case self.ReceiptTypes.INIT:
                if (scheduleActivationTimer) {
                    clearTimeout(scheduleActivationTimer);
                }

                scheduleActivationTimer = setTimeout(() => {
                    console.log("Scheduling activation");

                    needsActivation = true;

                    // otherwise activation is not done until next StatusResponse arrives
                    if ((0 != (trmStatus & self.StatusFlags.SHIFT_OPEN))
                        && (0 == (trmStatus & (self.StatusFlags.BUSY | self.StatusFlags.LOCKED)))) {
                        activate();
                    }
                }, 5000); 
                break;
            }

            if (rsp.ReceiptType == self.ReceiptTypes.TRX) {
                requestReceiptIfNecessary({ ReceiptType: self.ReceiptTypes.TRX_COPY, ReceiptID: confirmingTrxSeqCnt });
            }
        }
    }

    function createSMQ() {
        try {
            if ((window !== undefined)
                && (window.location !== undefined)) {
                smq = new SMQ.Client(window.location.protocol == "https:" ? "wss://ecritf.paytec.ch/smq.lsp" : "ws://ecritf.paytec.ch/smq.lsp");
            } else {
                smq = new SMQ.Client("wss://ecritf.paytec.ch/smq.lsp");
            }

            smq.onclose = function(message, canreconnect) {
                peerPTID = 0;

                if (canreconnect)
                    return 3000;
            };

            smq.onconnect = function() {
                console.log("Connected - no devices connected");
            };

            smq.onreconnect = function() {
                console.log("Reconnected - no devices connected");
            };
        }
        catch (e) {
            console.log(e.message);
            onError("Cannot create SMQ client object");
            smq = undefined;
        }
    }

    function onEFTHello(rsp) {
        smq.observe(peerPTID, disconnect);

        serialNumber = rsp.IFDSerialNum;
        terminalID = rsp.TrmID;

        sendConnectRequest();
        sendMessage({ StatusRequest: {}});
    }

    function clearHeartbeatTimer() {
        if (undefined !== heartbeatTimer) {
            clearTimeout(heartbeatTimer);
            heartbeatTimer = undefined;
        }
    }

    function heartbeat() {
        clearHeartbeatTimer();
        sendMessage({HeartbeatRequest: {}});
        heartbeatTimer = setTimeout(disconnect, heartbeatTimeout);
    }

    function generateUUID() {
        var dt = new Date().getTime();
        if(window && window.performance && typeof window.performance.now === "function"){
            dt += performance.now(); //use high-precision timer if available
        }
        var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = (dt + Math.random() * 16) % 16 | 0;
            dt = Math.floor(dt / 16);
            return (c == 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
        return uuid;
    }

    function deviceModelNameFromSerialNumber(serialNumber) {
        if (undefined !== serialNumber) {
            switch (serialNumber.slice(0, 3)) {
                case "ZTD":
                    return "PayTec Davinci";
                case "DTD":
                    return "PayTec Davinci (development)";
                case "PVD":
                    return "PayTec Davinci Vending";
                case "ZTP":
                    return "PayTec PRIMUS non-PCI";
                case "DTP":
                    return "PayTec PRIMUS non-PCI (development)";
                case "ZVA":
                    return "PayTec Verdi";
                case "ZVP":
                    return "PayTec Verdi Post";
                case "ZVB":
                    return "PayTec Verdi Post (contact-only)";
                case "ZKP":
                    return "PayTec PRIMUS DK";
                case "DKP":
                    return "PayTec PRIMUS DK (development)";
                case "ZKA":
                    return "PayTec Verdi DK";
                case "DKV":
                    return "PayTec Verdi DK (development)";
                case "ZTQ":
                    return "PayTec PRIMUS PCI PTS 3.x";
                case "DTQ":
                    return "PayTec PRIMUS PCI PTS 3.x (development)";
                case "MDP":
                    return "PayTec Merchant Device PRIMUS";
                case "MDV":
                    return "PayTec Merchant Device Verdi";
                case "ZTE":
                    return "PayTec Davinci II";
                case "DTE":
                    return "PayTec Davinci II (development)";
                case "PSP":
                    return "PayTec PRIMUS Self Park PCI PTS 4.x";
                case "IEM":
                case "IET":
                    return "PayTec PRIMUS Self Park PCI PTS 2.x";
                case "IED":
                    return "PayTec PRIMUS Self Park PCI PTS 2.x (development)";
                case "PVS":
                    return "PayTec PRIMUS payven small";
                case "DPS":
                    return "PayTec PRIMUS payven small (development)";
                case "RVM":
                    return "PayTec Reader Vending Motorized";
                case "DRM":
                    return "PayTec Reader Vending Motorized (development)";
                case "RVN":
                    return "PayTec Reader Vending Motorized PCI PTS 3.x";
                case "RVP":
                    return "PayTec Reader Vending Push";
                case "DRP":
                    return "PayTec Reader Vending Push (development)";
                case "RVQ":
                    return "PayTec Reader Vending Push 6mm heavy door";
                case "RVR":
                    return "PayTec Reader Vending Contactless";
                case "DRR":
                    return "PayTec Reader Vending Contactless (development)";
                case "PVA":
                    return "PayTec PRIMUS payven small RAL7016";
                case "PSI":
                case "PSK":
                case "PSL":
                case "PSM":
                    return "PayTec PRIMUS Self Inside";
                case "DSI":
                    return "PayTec PRIMUS Self Inside (development)";
                case "PTC":
                    return "PayTec C2";
                case "DTC":
                    return "PayTec C2 (Development)";
                case "RPI":
                case "RPS":
                    return "PayTec Reader Push Short";
                case "DRP":
                    return "PayTec Reader Push Short (development)";
                case "RRA":
                    return "PayTec Reader Contactless RAL7016";
                case "ZPD":
                    return "PayTec D1";
                case "DPD":
                    return "PayTec D1 (development)";
                case "PTR":
                    return "PTVS Contactless Reader";
                case "AVS":
                    return "PayTec V1";
                case "ADS":
                    return "PayTec V1 (development)";
                case "AVT":
                    return "PayTec V2";
                case "ADT":
                    return "PayTec V2 (development)";
                case "APS":
                    return "PayTec Reader Push Short PCI PTS 5.x";
                case "APD":
                    return "PayTec Reader Push Short PCI PTS 5.x (development)";
                case "AVP":
                    return "PayTec Reader Push PCI PTS 5.x";
                case "ADT":
                    return "PayTec Reader Push PCI PTS 5.x (development)";
                case "AVQ":
                    return "PayTec Reader Push PCI PTS 5.x 6mm heavy door";
                case "ADQ":
                    return "PayTec Reader Push PCI PTS 5.x 6mm heavy door (development)";
                case "AVN":
                    return "PayTec Reader Vending Motorized PCI PTS 5.x";
                case "ADN":
                    return "PayTec Reader Vending Motorized PCI PTS 5.x (development)";
                case "AVR":
                    return "PayTec Reader Vending Contactless PCI PTS 5.1";
                case "PCV":
                case "PCW":
                    return "PayTec Castles V3";
                case "ZVD":
                case "ZVE":
                    return "PayTec PayTec Castles V3 (development)";
                case "CVM":
                case "CVN":
                case "CVO":
                    return "PayTec Castles V3M2";
                case "CVD":
                case "CVE":
                    return "PayTec Castles V3M2 (Development)";
                case "CVP":
                    return "PayTec Castles V3P3";
                case "DVP":
                    return "PayTec Castles V3P3 (Development)";
                case "UPT":
                case "UPU":
                    return "PayTec Castles UPT1000F";
                case "UPD":
                case "UPE":
                    return "PayTec Castles UPT1000F (Development)";
                case "CMP":
                    return "PayTec Castles MP200";
                case "CMD":
                    return "PayTec Castles MP200 (Development)";
                case "N86":
                    return "PayTec Nexgo N86";
                case "D86":
                    return "PayTec Nexgo N86 (Development)";
                case "N6P":
                    return "PayTec Nexgo N6";
                case "N6D":
                    return "PayTec Nexgo N6 (Development)";
                case "N82":
                    return "PayTec Nexgo N82";
                case "D82":
                    return "PayTec Nexgo N82 (Development)";
                case "P2P":
                    return "PayTec Nexgo P200";
                case "P2D":
                    return "PayTec Nexgo P200 (Development)";
                case "UN2":
                    return "PayTec Nexgo UN20";
                case "UND":
                    return "PayTec Nexgo UN20 (Development)";
                case "S1F":
                    return "PayTec Castles S1F2";
                case "S1D":
                    return "PayTec Castles S1F2 (Development)";
                case "N96":
                    return "PayTec Nexgo N96";
                case "N9D":
                case "D96":
                    return "PayTec Nexgo N96 (Development)";
                case "N62":
                    return "PayTec Nexgo N62";
                case "D62":
                    return "PayTec Nexgo N62 (Development)";
                case "C2P":
                    return "PayTec Nexgo CT20P";
                case "D62":
                    return "PayTec Nexgo CT20P (Development)";
                case "N80":
                    return "PayTec Nexgo N80";
                case "D80":
                    return "PayTec Nexgo N80 (Development)";
            }
        }

        return "unknown";
    }
    
    function getStateName(s) {
        for (var i in State) {
            if (State[i] == s) {
                return i;
            }
        }

        return "State " + s;
    }

    function timeStamp() {
        var now = new Date();

        return pad(now.getFullYear(), 2) + "-" + pad(now.getMonth() + 1, 2) + "-" + pad(now.getDate(), 2)
            + " " + pad(now.getHours(), 2) + ":" + pad(now.getMinutes(), 2) + ":" + pad(now.getSeconds(), 2)
            + "." + pad(now.getMilliseconds(), 3) + ": ";
    }

    function pad(num, padlen, padchar) {
        var pad_char = typeof padchar !== 'undefined' ? padchar : '0';
        var padArray = new Array(1 + padlen).join(pad_char);
        return (padArray + num).slice(-padArray.length);
    }
};

