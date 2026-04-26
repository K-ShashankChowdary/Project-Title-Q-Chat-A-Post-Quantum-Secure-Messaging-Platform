import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

/**
 * Generates an ML-KEM-768 keypair.
 * Returns { publicKey: Uint8Array, privateKey: Uint8Array }
 */
export async function generateKeyPair() {
  const keys = ml_kem768.keygen();
  return {
    publicKey: keys.publicKey,
    privateKey: keys.secretKey
  };
}

/**
 * Derives a 256-bit AES key from a shared secret using SHA-256.
 */
async function deriveAESKey(sharedSecret) {
  const hash = await crypto.subtle.digest('SHA-256', sharedSecret);
  return crypto.subtle.importKey(
    'raw',
    hash,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts a message using ML-KEM + AES-256-GCM hybrid encryption.
 * @param {string} text - The plaintext message
 * @param {Uint8Array} recipientPublicKey - The recipient's ML-KEM public key
 * @returns {Promise<Object>} - Encrypted payload structure
 */
export async function encryptMessage(text, recipientPublicKey) {
  if (!text) throw new Error('EMPTY_MESSAGE');
  if (!recipientPublicKey || recipientPublicKey.byteLength !== 1184) {
    throw new Error(`INVALID_PUBLIC_KEY: expected 1184 bytes, got ${recipientPublicKey?.byteLength}`);
  }

  // 1. ML-KEM Encapsulation
  const { sharedSecret, cipherText: encapsulatedKey } = ml_kem768.encapsulate(recipientPublicKey);

  // 2. Derive AES key from shared secret
  const aesKey = await deriveAESKey(sharedSecret);

  // 3. Encrypt data with AES-GCM
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const encodedData = encoder.encode(text);

  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    encodedData
  );

  // Buffer contains [ciphertext... , authTag (16 bytes)]
  const encryptedArray = new Uint8Array(encryptedBuffer);
  const ciphertext = encryptedArray.slice(0, -16);
  const authTag = encryptedArray.slice(-16);

  return {
    encapsulatedKey: b64encode(encapsulatedKey),
    nonce: b64encode(iv),
    ciphertext: b64encode(ciphertext),
    authTag: b64encode(authTag),
    timestamp: Date.now()
  };
}

/**
 * Decrypts a message using ML-KEM + AES-256-GCM hybrid encryption.
 * Validates the payload structure and decapsulates the ML-KEM shared secret,
 * then derives the AES key to decrypt the payload.
 * 
 * @param {Object} payload - The encrypted payload { encapsulatedKey, nonce, ciphertext, authTag }
 * @param {Uint8Array} myPrivateKey - My private ML-KEM key (2400 bytes for ML-KEM-768)
 * @returns {Promise<string>} - The decrypted plaintext
 */
export async function decryptMessage(payload, myPrivateKey) {
  if (!payload || !payload.encapsulatedKey || !payload.nonce || !payload.ciphertext || !payload.authTag) {
    throw new Error('INVALID_PAYLOAD_STRUCTURE');
  }

  try {
    const encapKey = b64decode(payload.encapsulatedKey);
    const iv = b64decode(payload.nonce);
    const ciphertext = b64decode(payload.ciphertext);
    const authTag = b64decode(payload.authTag);

    // 1. ML-KEM Decapsulation
    const sharedSecret = ml_kem768.decapsulate(encapKey, myPrivateKey);

    // 2. Derive AES key from shared secret
    const aesKey = await deriveAESKey(sharedSecret);

    // 3. Decrypt data with AES-GCM
    // SubtleCrypto expects [ciphertext, authTag] concatenated
    const combined = new Uint8Array(ciphertext.length + authTag.length);
    combined.set(ciphertext);
    combined.set(authTag, ciphertext.length);

    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      combined
    );

    return new TextDecoder().decode(decryptedBuffer);
  } catch (error) {
    console.error('Decryption failed:', error);
    throw new Error('DECRYPTION_FAILED');
  }
}

/**
 * Calculates a basic Merkle Root (Hash Chain) for a conversation.
 * @param {Array} messages - List of decrypted message objects
 * @returns {Promise<string>} - The conversation integrity hash
 */
export async function calculateIntegrity(messages) {
  if (messages.length === 0) return '0x0000...';
  
  let currentHash = new Uint8Array(32); // Initial seed
  const encoder = new TextEncoder();

  for (const msg of messages) {
    const data = encoder.encode(msg.text + msg.timestamp);
    const combined = new Uint8Array(currentHash.length + data.length);
    combined.set(currentHash);
    combined.set(data, currentHash.length);
    
    const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
    currentHash = new Uint8Array(hashBuffer);
  }

  return b64encode(currentHash).slice(0, 16) + '...';
}

// Helpers for Base64 coding
export function b64encode(uint8) {
  let binary = '';
  const len = uint8.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(uint8[i]);
  }
  return btoa(binary);
}

export function b64decode(b64) {
  if (typeof b64 !== 'string') return new Uint8Array();
  // Decode base64 to a raw binary string, then convert to Uint8Array
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    arr[i] = bin.charCodeAt(i);
  }
  return arr;
}
