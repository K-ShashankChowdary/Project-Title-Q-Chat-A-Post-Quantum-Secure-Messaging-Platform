import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { encryptMessage, decryptMessage, b64decode, calculateIntegrity } from '../crypto/encryption';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Send, Terminal, Shield, LogOut, Lock, Fingerprint,
  AlertTriangle, Users, Zap, ShieldCheck, Trash2
} from 'lucide-react';

/* ─── Avatar palette ─── */
const GRADIENTS = [
  'from-cyan-400 to-blue-500',
  'from-pink-400 to-rose-600',
  'from-emerald-400 to-cyan-500',
  'from-amber-400 to-orange-500',
  'from-violet-400 to-purple-600',
];
const avatarGrad = (name = '') => GRADIENTS[name.charCodeAt(0) % GRADIENTS.length];

/* ─── Format timestamp ─── */
const fmt = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function ChatDashboard() {
  const navigate = useNavigate();
  const currentUser   = JSON.parse(localStorage.getItem('qchat_user') || '{}');
  const privateKeyB64 = currentUser.id ? localStorage.getItem(`qchat_priv_${currentUser.id}`) : null;
  const privateKey    = privateKeyB64 ? b64decode(privateKeyB64) : null;

  const socketRef = useRef(null);
  const [users, setUsers]               = useState([]);
  const [peer, setPeer]                 = useState(null);
  const [messages, setMessages]         = useState([]);
  const [input, setInput]               = useState('');
  const [logs, setLogs]                 = useState([]);
  const [encrypting, setEncrypting]     = useState(false);
  const [showConsole, setShowConsole]   = useState(true);
  const [integrity, setIntegrity]       = useState(null);
  const [connStatus, setConnStatus]     = useState('connecting');

  /* Persist selected peer across refreshes */
  const selectPeer = (u) => {
    setPeer(u);
    if (u) sessionStorage.setItem('qchat_last_peer', JSON.stringify(u));
    else    sessionStorage.removeItem('qchat_last_peer');
  };

  const bottomRef        = useRef(null);
  const inputRef         = useRef(null);
  const peerRestoredRef  = useRef(false);  // gate: only restore peer once per mount
  const peerRef          = useRef(null);   // always-current peer without stale closure

  // Keep peerRef in sync with peer state
  useEffect(() => { peerRef.current = peer; }, [peer]);

  /* ─── Socket setup ─── */
  useEffect(() => {
    if (!currentUser.id) { navigate('/login'); return; }

    const s = io('http://localhost:5000', {
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 10,
    });
    socketRef.current = s;

    s.on('connect', () => {
      setConnStatus('connected');
      s.emit('register_socket', currentUser.id);
      addLog('Connected to secure relay server', 'cyan');
      addLog(`Session active · User ID: ...${String(currentUser.id).slice(-6)}`, 'cyan');
    });

    s.on('disconnect', () => {
      setConnStatus('disconnected');
      addLog('Server disconnected — attempting to reconnect', 'pink');
    });

    s.on('reconnecting', () => {
      setConnStatus('connecting');
      addLog('Reconnecting to server...', 'info');
    });

    s.on('reconnect', () => {
      setConnStatus('connected');
      s.emit('register_socket', currentUser.id);
      addLog('Reconnected ✓ · Session restored', 'cyan');
    });

    s.on('new_message', async (msg) => {
      try {
        const text = await decryptMessage(msg.payload, privateKey);
        
        // Only append to the current view if we are actively chatting with the sender
        if (peerRef.current && String(peerRef.current.id) === String(msg.fromId)) {
          setMessages(prev => {
            if (prev.some(m => String(m.id) === String(msg.id))) return prev;
            return [...prev, { ...msg, text, isMine: false }];
          });
          addLog('Message received · Decapsulating shared secret', 'green');
          addLog('Decryption successful ✓ · Message authenticated', 'green');
        } else {
          // Message is for another user, or we have no active chat.
          // It's saved in the DB, so we'll see it when we open their chat.
          addLog(`New offline/background message received from ${String(msg.fromId).slice(-6)}`, 'info');
        }
      } catch {
        if (peerRef.current && String(peerRef.current.id) === String(msg.fromId)) {
          setMessages(prev => {
            if (prev.some(m => String(m.id) === String(msg.id))) return prev;
            return [...prev, { ...msg, text: '[Locked — previous session key]', isMine: false, error: true }];
          });
          addLog('Could not decrypt message — key mismatch (old session)', 'pink');
        }
      }
    });

    s.on('user_status', fetchUsers);

    fetchUsers();
    return () => s.close();
  }, []);

  /* ─── Load history on peer change ─── */
  useEffect(() => {
    if (!peer) return;
    setMessages([]); setIntegrity(null);
    loadHistory(peer.id);
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [peer]);

  /* ─── Scroll + integrity on message update ─── */
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    const ok = messages.filter(m => !m.error);
    if (ok.length) calculateIntegrity(ok).then(setIntegrity);
  }, [messages]);

  const addLog = useCallback((msg, type = 'info') => {
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLogs(prev => [...prev, { msg, type, t }].slice(-25));
  }, []);

  const fetchUsers = useCallback(async () => {
    try {
      const { data } = await axios.get('/api/users', {
        headers: { Authorization: `Bearer ${localStorage.getItem('qchat_token')}` }
      });
      setUsers(data);

      // If the currently selected peer is in the list, refresh their public_key
      // so we always encrypt with the latest key (handles key rotation)
      if (peerRef.current) {
        const refreshed = data.find(u => String(u.id) === String(peerRef.current.id));
        if (refreshed && refreshed.public_key !== peerRef.current.public_key) {
          setPeer(prev => ({ ...prev, public_key: refreshed.public_key }));
        }
      }

      /* ── Restore last peer after refresh — only once per mount ── */
      const savedPeer = sessionStorage.getItem('qchat_last_peer');
      if (savedPeer && !peerRestoredRef.current) {
        peerRestoredRef.current = true;
        try {
          const sp    = JSON.parse(savedPeer);
          const found = data.find(u => String(u.id) === String(sp.id));
          if (found) setPeer({ ...found, id: String(found.id) });
        } catch { /* ignore corrupt data */ }
      }
    } catch { /* silent */ }
  }, []);

  const loadHistory = async (peerId) => {
    try {
      const { data } = await axios.get(`/api/messages/${peerId}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('qchat_token')}` }
      });
      const history = await Promise.all(data.map(async msg => {
        const isMine = String(msg.fromId) === String(currentUser.id);
        if (isMine) {
          // Decrypt the sender's copy with our own private key
          if (msg.senderPayload) {
            try {
              const text = await decryptMessage(msg.senderPayload, privateKey);
              return { ...msg, text, isMine: true };
            } catch { /* fall through */ }
          }
          return { ...msg, text: '[Sent — previous session]', isMine: true, error: true };
        }
        try {
          return { ...msg, text: await decryptMessage(msg.payload, privateKey), isMine: false };
        } catch {
          return { ...msg, text: '[Locked — previous session key]', isMine: false, error: true };
        }
      }));
      setMessages(history);
    } catch { /* silent */ }
  };

  const sendMessage = async (e) => {
    e?.preventDefault();
    if (!input.trim() || !peer || !socketRef.current || encrypting) return;
    const text = input.trim();
    setInput('');
    setEncrypting(true);
    const t0 = performance.now();
    addLog(`Encrypting message for ${peer.username}`, 'cyan');
    addLog('Generating shared secret with ML-KEM-768 (1184B public key)', 'cyan');
    try {
      const recipientPubKey = b64decode(peer.public_key);
      // Encrypt for recipient
      const payload = await encryptMessage(text, recipientPubKey);

      // Encrypt a copy for ourselves so we can read our own sent messages
      let senderPayload = null;
      const parsedUser = JSON.parse(localStorage.getItem('qchat_user') || '{}');
      const myPubKeyB64 = parsedUser.publicKey || parsedUser.public_key;
      if (myPubKeyB64) {
        senderPayload = await encryptMessage(text, b64decode(myPubKeyB64));
      }

      const ms = (performance.now() - t0).toFixed(1);
      addLog('Shared secret wrapped ✓ · 1088B encrypted key', 'green');
      addLog(`Message locked with AES-256-GCM ✓ · Delivered in ${ms} ms`, 'green');
      socketRef.current?.emit('send_message', { toId: peer.id, fromId: currentUser.id, payload, senderPayload });
      setMessages(prev => [...prev, { id: `l-${Date.now()}`, text, isMine: true, timestamp: new Date() }]);
    } catch (err) {
      addLog(`Encryption failed: ${err.message}`, 'pink');
    } finally {
      setEncrypting(false);
    }
  };

  const clearChat = async () => {
    if (!peer) return;
    if (!window.confirm(`Clear all messages with ${peer.username}? This cannot be undone.`)) return;
    try {
      await axios.delete(`/api/messages/${peer.id}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('qchat_token')}` }
      });
      setMessages([]);
      setIntegrity(null);
      addLog(`Conversation with ${peer.username} cleared`, 'pink');
    } catch {
      addLog('Failed to clear conversation', 'pink');
    }
  };

  const handleKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const logout = () => {
    localStorage.removeItem('qchat_token');
    localStorage.removeItem('qchat_user');
    navigate('/login');
  };

  /* ─────────────── RENDER ─────────────── */
  return (
    <div className="relative h-screen flex overflow-hidden bg-navy-950">
      <div className="bg-grid" />
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
        <div className="orb w-[700px] h-[700px] bg-blue-900/20 -top-60 -left-40" />
        <div className="orb w-[500px] h-[500px] bg-indigo-900/15 -bottom-40 -right-20" style={{ animationDelay: '-9s' }} />
      </div>

      {/* ══════ SIDEBAR ══════ */}
      <aside className="relative z-10 w-72 flex flex-col m-3 mr-0 glass flex-shrink-0">

        {/* Brand */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-400 to-blue-500 flex items-center justify-center shadow-glow-cyan-sm">
              <ShieldCheck size={15} className="text-navy-950" />
            </div>
            <span className="font-extrabold text-sm tracking-tight">QChat</span>
          </div>
          <span className="badge-pq"><Zap size={9} />PQ-Secure</span>
        </div>

        {/* Section label */}
        <div className="px-5 pt-4 pb-2 flex items-center gap-2">
          <Users size={11} className="text-slate-600" />
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted">
            {users.length} peer{users.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* User list */}
        <div className="flex-1 overflow-y-auto px-2.5 pb-2 space-y-0.5">
          {users.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-muted">
              <Users size={28} className="opacity-20" />
              <p className="text-xs">No peers online yet</p>
            </div>
          ) : users.map(u => (
            <motion.button
              key={u.id} whileTap={{ scale: 0.98 }}
              onClick={() => selectPeer({ ...u, id: String(u.id) })}
              className={`user-row w-full text-left ${peer?.id === String(u.id) ? 'active' : ''}`}
            >
              {/* Avatar */}
              <div className={`relative w-9 h-9 rounded-full bg-gradient-to-br ${avatarGrad(u.username)} flex items-center justify-center font-bold text-sm text-white flex-shrink-0`}>
                {u.username[0].toUpperCase()}
                <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-navy-800 shadow-glow-green" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-sm truncate">{u.username}</p>
                <p className="text-[10px] flex items-center gap-1 text-emerald-400/80">
                  <Shield size={9} /> ML-KEM-768 active
                </p>
              </div>
            </motion.button>
          ))}
        </div>

        {/* Me */}
        <div className="px-4 py-3.5 border-t border-white/[0.06] flex items-center gap-2.5">
          <div className={`w-8 h-8 rounded-full bg-gradient-to-br ${avatarGrad(currentUser.username || '')} flex items-center justify-center font-bold text-sm text-white flex-shrink-0`}>
            {(currentUser.username || 'U')[0].toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate">{currentUser.username}</p>
            <p className={`text-[10px] flex items-center gap-1 ${
              connStatus === 'connected'    ? 'text-emerald-400' :
              connStatus === 'connecting'   ? 'text-amber-400'   : 'text-rose-400'
            }`}>
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                connStatus === 'connected'  ? 'bg-emerald-400' :
                connStatus === 'connecting' ? 'bg-amber-400 animate-pulse' : 'bg-rose-400'
              }`} />
              {connStatus === 'connected' ? 'Connected' : connStatus === 'connecting' ? 'Reconnecting...' : 'Disconnected'}
            </p>
          </div>
          <button onClick={logout} className="btn-ghost p-2 rounded-lg" title="Log out">
            <LogOut size={14} />
          </button>
        </div>
      </aside>

      {/* ══════ MAIN AREA ══════ */}
      <main className="relative z-10 flex-1 flex flex-col m-3 glass overflow-hidden">
        {peer ? (
          <>
            {/* ── Chat header ── */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.06] flex-shrink-0 gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className={`relative w-9 h-9 rounded-full bg-gradient-to-br ${avatarGrad(peer.username)} flex items-center justify-center font-bold text-sm text-white flex-shrink-0`}>
                  {peer.username[0].toUpperCase()}
                  <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-navy-800" />
                </div>
                <div className="min-w-0">
                  <p className="font-bold text-base leading-tight truncate">{peer.username}</p>
                  {integrity && (
                    <p className="flex items-center gap-1 text-[10px] text-slate-500 font-mono">
                      <Fingerprint size={9} className="text-cyan-400" />
                      {integrity}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="badge-encrypted">
                  <Lock size={9} /> End-to-End Encrypted
                </span>
                <button
                  className="btn-ghost p-2 rounded-lg text-slate-500 hover:text-rose-400 hover:border-rose-400/30 hover:bg-rose-400/5"
                  onClick={clearChat}
                  title="Clear conversation"
                >
                  <Trash2 size={14} />
                </button>
                <button
                  className={`btn-ghost p-2 rounded-lg ${showConsole ? 'text-cyan-400 border-cyan-400/30 bg-cyan-400/5' : ''}`}
                  onClick={() => setShowConsole(v => !v)}
                  title="Toggle crypto console"
                >
                  <Terminal size={14} />
                </button>
              </div>
            </div>

            {/* ── Messages ── */}
            <div className="flex-1 overflow-y-auto px-4 py-5">
              <div className="flex flex-col gap-2">
              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-3 text-center py-16">
                  <div className="w-14 h-14 rounded-full bg-cyan-400/5 border border-cyan-400/15 flex items-center justify-center">
                    <Lock size={22} className="text-cyan-400/60" />
                  </div>
                  <div>
                    <p className="font-semibold text-slate-400 text-sm">Start a secure conversation</p>
                    <p className="text-xs text-muted mt-1">ML-KEM-768 + AES-256-GCM · FIPS 203</p>
                  </div>
                </div>
              )}

              <AnimatePresence initial={false}>
                {messages.map((msg, i) => {
                  const isGrouped = i > 0 && messages[i - 1].isMine === msg.isMine;
                  return (
                    <motion.div
                      key={msg.id || i}
                      className={`flex items-end gap-2 ${
                        msg.isMine ? 'justify-end' : 'justify-start'
                      } ${isGrouped ? 'mt-0.5' : 'mt-2'}`}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                    >
                      {/* Peer avatar — show only on last message of a group */}
                      {!msg.isMine && (
                        <div className={`w-7 h-7 rounded-full bg-gradient-to-br ${avatarGrad(peer.username)} flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0 ${
                          isGrouped ? 'invisible' : ''
                        }`}>
                          {peer.username[0].toUpperCase()}
                        </div>
                      )}

                      <div className={`flex flex-col ${
                        msg.isMine ? 'items-end' : 'items-start'
                      }`} style={{ maxWidth: '68%' }}>
                        <div className={[
                          msg.isMine ? 'bubble-mine' : 'bubble-theirs',
                          msg.error ? 'bubble-error' : ''
                        ].filter(Boolean).join(' ')}>
                          {msg.text}
                        </div>
                        <span className="text-[10px] text-muted font-mono mt-1 px-1">
                          {fmt(msg.timestamp)}
                        </span>
                      </div>

                      {/* Spacer so mine messages don't hug the edge */}
                      {msg.isMine && <div className="w-0 flex-shrink-0" />}
                    </motion.div>
                  );
                })}
              </AnimatePresence>
              <div ref={bottomRef} />
              </div>
            </div>

            {/* ── Input bar ── */}
            <div className="relative px-4 py-3.5 border-t border-white/[0.06] flex-shrink-0">
              <AnimatePresence>
                {encrypting && (
                  <motion.div
                    initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}
                    className="absolute -top-9 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-navy-800 border border-cyan-400/25 text-cyan-400 text-[11px] font-mono whitespace-nowrap shadow-glow-cyan-sm"
                  >
                    <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                    Encrypting with ML-KEM-768...
                  </motion.div>
                )}
              </AnimatePresence>

              <form onSubmit={sendMessage} className="flex items-center gap-3">
                <input
                  ref={inputRef}
                  className="field-input flex-1 !rounded-full !py-2.5 !px-5 !mb-0"
                  type="text"
                  placeholder={`Message ${peer.username}...`}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={encrypting}
                  autoComplete="off"
                />
                <button type="submit" className="btn-icon-send" disabled={!input.trim() || encrypting}>
                  <Send size={16} />
                </button>
              </form>
            </div>

            {/* ── Crypto Console ── */}
            <AnimatePresence>
              {showConsole && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }} animate={{ height: 144, opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: 'easeInOut' }}
                  className="flex-shrink-0 border-t border-white/[0.06] bg-black/25 overflow-hidden"
                >
                  {/* macOS-style title bar */}
                  <div className="flex items-center gap-2 px-3.5 py-2 border-b border-white/[0.05]">
                    <div className="flex gap-1.5">
                      <div className="w-3 h-3 rounded-full bg-rose-500/80" />
                      <div className="w-3 h-3 rounded-full bg-amber-400/80" />
                      <div className="w-3 h-3 rounded-full bg-emerald-400/80" />
                    </div>
                    <Terminal size={11} className="text-slate-600 ml-1" />
                    <span className="text-[10px] font-semibold tracking-widest uppercase text-slate-600">
                      Quantum Protocol Stream
                    </span>
                  </div>
                  {/* Log body */}
                  <div className="h-[88px] overflow-y-auto px-3.5 py-2 space-y-0.5">
                    {logs.length === 0
                      ? <p className="text-[11px] font-mono text-slate-600 italic">Awaiting crypto events...</p>
                      : logs.map((l, i) => (
                        <div key={i} className="console-line">
                          <span className="text-slate-600">[{l.t}]</span>
                          <span className={
                            l.type === 'green' ? 'text-emerald-400' :
                            l.type === 'cyan'  ? 'text-cyan-400'    :
                            l.type === 'pink'  ? 'text-rose-400'    : 'text-slate-400'
                          }>{l.msg}</span>
                        </div>
                      ))
                    }
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        ) : (
          /* ── Empty state ── */
          <div className="h-full flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
              <p className="text-sm text-muted">Select a peer to start</p>
              <div className="flex gap-2">
                <span className="badge-encrypted"><Lock size={9} /> AES-256-GCM</span>
                <span className="badge-pq"><ShieldCheck size={9} /> ML-KEM-768</span>
              </div>
            </div>

            <div className="flex-1 flex flex-col items-center justify-center gap-6 text-center p-10">
              {/* Animated shield */}
              <div className="relative w-20 h-20">
                <div className="absolute inset-0 rounded-full bg-cyan-400/5 border border-cyan-400/15 flex items-center justify-center">
                  <ShieldCheck size={32} className="text-cyan-400/70" />
                </div>
                <div className="absolute inset-0 rounded-full border border-cyan-400/10 animate-ping" style={{ animationDuration: '3s' }} />
              </div>

              <div>
                <h2 className="text-xl font-bold mb-2">Post-Quantum Secure Channel</h2>
                <p className="text-sm text-muted max-w-sm leading-relaxed">
                  Choose a peer from the sidebar to open a hybrid{' '}
                  <span className="text-cyan-400 font-semibold">ML-KEM-768</span> +{' '}
                  <span className="text-emerald-400 font-semibold">AES-256-GCM</span> encrypted channel.
                </p>
              </div>

              {/* Info grid */}
              <div className="grid grid-cols-3 gap-3 w-full max-w-sm">
                {[
                  { label: 'KEM Algorithm', value: 'ML-KEM-768', color: 'text-cyan-400' },
                  { label: 'Symmetric Cipher', value: 'AES-256-GCM', color: 'text-emerald-400' },
                  { label: 'Standard', value: 'NIST FIPS 203', color: 'text-amber-400' },
                ].map(c => (
                  <div key={c.label} className="glass-sm p-3 text-center">
                    <p className={`text-xs font-bold font-mono ${c.color} truncate`}>{c.value}</p>
                    <p className="text-[10px] text-muted mt-1 uppercase tracking-wide truncate">{c.label}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
