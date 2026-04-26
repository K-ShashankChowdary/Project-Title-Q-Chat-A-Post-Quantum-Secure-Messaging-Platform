# QChat: Post-Quantum Secure Messaging & Cryptographic Whitepaper

QChat is a next-generation End-to-End Encrypted (E2EE) messaging platform built to resist the "Harvest Now, Decrypt Later" threat of quantum computing. It implements a Zero-Knowledge backend architecture and a highly optimized Hybrid Cryptographic strategy.

## 🛠 Technology Stack
- **Frontend**: React (Vite), Socket.io-client, `@noble/post-quantum`.
- **Backend**: Node.js, Express, Socket.io, MongoDB (Mongoose).
- **Cryptography**: ML-KEM-768, AES-256-GCM, SHA-256.

---

## 🏗 Setup & Installation

### Prerequisites
- Node.js v20 or higher

### 1. Clone & Install
```bash
# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

### 2. Configure Environment
Create a `.env` file in the `backend/` directory:
```
PORT=5000
JWT_SECRET=your-secure-secret
MONGO_URI=mongodb://localhost:27017/qchat
```

### 3. Run Development Servers
```bash
# Terminal 1: Backend
cd backend
npm run dev

# Terminal 2: Frontend
cd frontend
npm run dev
```

---

## 2. In-Depth Cryptographic Pipeline (The Core)

QChat employs a completely local, client-side, **Hybrid Encryption Strategy** combining Lattice Math and Symmetric Advanced Encryption Standards. The Node.js server sees absolutely zero plaintext.

### 2.1 The Theory & Algorithms of ML-KEM-768
Traditional RSA/ECC math relies on Integer Factorization, which is solved easily by Shor's Algorithm on quantum hardware. ML-KEM operates differently: it constructs a hyper-dimensional lattice problem over a polynomial ring $R_q = \mathbb{Z}_q[X]/(X^{256} + 1)$ with modulus $q = 3329$. Because it's mathematically chaotic to find "short vectors" in this multi-dimensional lattice space (The Module Learning With Errors problem), it is completely immune to quantum hardware. We use **ML-KEM-768** ($k=3$), perfectly balancing security and speed.

#### Core Formulas:
1. **Key Generation:**
   - Generate random square matrix $A \in R_q^{3 \times 3}$.
   - Generate small secret vector $s \in R_q^3$ and error vector $e \in R_q^3$.
   - **Public Key Formula:** $t = A s + e$
   - *Public Key = $(A, t)$, Secret Key = $(s)$.*

2. **Encapsulation (Sender generates ciphertext $c$ and Shared Secret $SS$ for Recipient):**
   - Generate error vectors $e_1 \in R_q^3, e_2 \in R_q$.
   - Compute polynomial $u = A^T r + e_1$.
   - Compute scalar polynomial $v = t^T r + e_2 + \text{Encode}(SS)$.
   - *Ciphertext $c = (u, v)$ is sent across the wire.*

3. **Decapsulation (Recipient unlocks $SS$):**
   - Recipient applies their Secret Key $(s)$.
   - $v - s^T u = (t^T r + e_2 + \text{Encode}(SS)) - s^T(A^T r + e_1) \approx \text{Encode}(SS)$.
   - The microscopic errors successfully cancel out, decoding back to the exact $SS$.

### 2.2 Code Implementation: Keypair Generation & Vaulting
*File: `frontend/src/components/Register.jsx`*
When a user registers or logs into a new device, the browser triggers generation directly in RAM:

```javascript
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

// 1. Generate Lattices
const keys = ml_kem768.keygen();

// 2. Vault Private Key strictly in local storage
const b64Priv = b64encode(keys.secretKey); 
localStorage.setItem(`qchat_priv_${username}`, b64Priv);

// 3. Transmit 1184-byte Public Key to Server
const b64Pub = b64encode(keys.publicKey);
await axios.post('/api/auth/register', { username, password, publicKey: b64Pub });
```
**Storage Specifications:** 
*   **Public Key:** Exactly **1184 bytes**. Stored in MongoDB.
*   **Private/Secret Key:** Exactly **2400 bytes**. Stored exclusively in local `localStorage`. **It never touches a network request.**

### 2.3 Code Implementation: Encrypting the Transmission
*File: `frontend/src/crypto/encryption.js`*

When Alice sends "Hello" to Bob, Bob's 1184-byte Public Key is fetched to encapsulate a secret. Because KEM systems encrypt data incredibly slowly, QChat implements a Key Derivation Function (KDF) into a fast, symmetric AES-256 cipher.

```javascript
export async function encryptMessage(text, recipientPublicKey) {
  // 1. ML-KEM Encapsulation (Generates 1088-byte lattice ciphertext & 32-byte secret)
  const { sharedSecret, cipherText: encapsulatedKey } = ml_kem768.encapsulate(recipientPublicKey);

  // 2. Key Derivation (Hash lattice secret to raw AES symmetric key)
  const hashBuffer = await crypto.subtle.digest('SHA-256', sharedSecret);
  const aesKey = await crypto.subtle.importKey('raw', hashBuffer, { name: 'AES-GCM' }, false, ['encrypt']);

  // 3. AES-256-GCM Symmetric Fast-Encryption
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encodedText = new TextEncoder().encode(text);
  
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, 
    aesKey, 
    encodedText
  );

  // Buffer automatically contains [Ciphertext... + 16-byte AuthTag MAC]
  const encryptedArray = new Uint8Array(encryptedBuffer);
  const ciphertext = encryptedArray.slice(0, -16);
  const authTag = encryptedArray.slice(-16);

  // 4. Return as JSON mapping logic
  return {
    encapsulatedKey: b64encode(encapsulatedKey),
    nonce: b64encode(iv),
    ciphertext: b64encode(ciphertext),
    authTag: b64encode(authTag),
  };
}
```

The 16-byte `authTag` is a MAC (Message Authentication Code). If the server tries to flip a single bit of the ciphertext stream, the Native Web Crypto subsystem instantly invalidates decoding to prevent tamper attacks.

### 2.4 Code Implementation: Decrypting the Transmission
When Bob's socket receives the payload, the sequence is inverted:
```javascript
export async function decryptMessage(encryptedPayload, myPrivateKey) {
  // 1. Lattice Decapsulation using Vaulted Secret Key
  const encKeyArray = b64decode(encryptedPayload.encapsulatedKey);
  const sharedSecret = ml_kem768.decapsulate(encKeyArray, myPrivateKey);

  // 2. Map Shared Secret back to identical AES Key
  const hashBuffer = await crypto.subtle.digest('SHA-256', sharedSecret);
  const aesKey = await crypto.subtle.importKey('raw', hashBuffer, { name: 'AES-GCM' }, false, ['decrypt']);

  // 3. Build Authentication Block
  const ivBuffer = b64decode(encryptedPayload.nonce);
  const cipherBuffer = b64decode(encryptedPayload.ciphertext);
  const authTagBuffer = b64decode(encryptedPayload.authTag);
  
  const combinedBuffer = new Uint8Array(cipherBuffer.length + authTagBuffer.length);
  combinedBuffer.set(cipherBuffer);
  combinedBuffer.set(authTagBuffer, cipherBuffer.length);

  // 4. Unlock
  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBuffer },
    aesKey,
    combinedBuffer
  );

  return new TextDecoder().decode(decryptedBuffer);
}
```

---

## 3. Real-Time Network & Synchronization Logic

### 3.1 Active Key Assertion (Resolving the multi-device E2E Flaw)
*File: `frontend/src/components/Login.jsx`*

In traditional E2E architectures, moving from Desktop to Laptop permanently breaks encryption workflows if the backend doesn't know you switched matrices. 
QChat solves this definitively. When you click Login, the browser forcefully assesses local storage. If a valid Post-Quantum keypair exists, it physically forces the backend to obey the active device:

```javascript
// Active Key Assertion Protocol check
const existingPub = localStorage.getItem(`qchat_pub_${data.user.username}`);

if (existingPub) {
  // Sync the backend DB to THIS exact browser tab
  await axios.post('/api/auth/update-key', 
    { userId: data.user.id, publicKey: existingPub },
    { headers: { Authorization: `Bearer ${data.token}` } }
  );
}
```

### 3.2 MongoDB Optimization Matrix
*File: `backend/db/database.js`*

Fetching real-time chat blocks is inherently heavy because it probes massive intersection paths: `(from A to B) OR (from B to A)`. Without structural intervention, querying 100,000 messages triggers $O(N)$ CPU sweeps. We resolve this precisely using MongoDB compound Multi-Key schemas:

```javascript
const messageSchema = new mongoose.Schema({
  from_user_id:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  to_user_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  payload:        { type: Object, required: true }, 
  timestamp:      { type: Date, default: Date.now, index: true },
  delivered:      { type: Boolean, default: false }
});

// Explicit Native Compound Indexer for $or acceleration
messageSchema.index({ from_user_id: 1, to_user_id: 1, timestamp: -1 });
```

---

## 4. Merkle-Tree Integrity Hash Chain
*File: `frontend/src/crypto/encryption.js -> calculateIntegrity`*

To prevent the Zero-Knowledge backend from arbitrarily destroying chat sequences or executing selective-deletion assaults, QChat implements a block-synchronization hash string mathematically mirroring blockchain technology.

#### Hash Formalism
$H_n = \text{SHA256}_{digest}(H_{n-1} + \text{Text}_n + \text{Timestamp}_n)$

#### Execution Snippet
```javascript
export async function calculateIntegrity(messages) {
  let currentHash = new Uint8Array(32); // Seed

  for (const msg of messages) {
    const data = new TextEncoder().encode(msg.text + msg.timestamp);
    
    // Concat previous hash recursively to the current payload data
    const combined = new Uint8Array(currentHash.length + data.length);
    combined.set(currentHash);
    combined.set(data, currentHash.length);
    
    // Hash the recursive array outputting a cascading checksum
    const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
    currentHash = new Uint8Array(hashBuffer); 
  }

  return b64encode(currentHash).slice(0, 16) + '...';
}
```
If a database administrator shifts the `timestamp` or `payload` of arbitrary Message number 5, the microscopic data corruption heavily magnifies the ensuing hash derivatives across `combined.set(currentHash)`, instantly voiding the UI integrity string mapping at Message 50.
