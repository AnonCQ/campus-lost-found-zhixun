/**
 * Firebase Initialization, Anonymous Session Bootstrap, Error Handler, and Storage/EXIF Helper
 */

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import { doc, getDocFromServer, getFirestore } from 'firebase/firestore';
import { getDownloadURL, getStorage, ref, uploadBytes } from 'firebase/storage';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const storage = getStorage(app);
storage.maxUploadRetryTime = 3500;
storage.maxOperationRetryTime = 3500;
export const googleProvider = new GoogleAuthProvider();

let anonymousUidCache: string | null = null;
let sessionBootstrapPromise: Promise<string | null> | null = null;

/**
 * Step 1: On app startup, if no Firebase user is signed in, sign in anonymously with Firebase Auth
 * (signInAnonymously) before any Firestore read/write, and keep the signed-in anonymous UID for
 * the demo session. Never presents anonymous sign-in as a real user identity in the UI.
 */
export function ensureAnonymousOrActiveSession(): Promise<string | null> {
  if (auth.currentUser) {
    anonymousUidCache = auth.currentUser.uid;
    return Promise.resolve(auth.currentUser.uid);
  }
  if (sessionBootstrapPromise) {
    return sessionBootstrapPromise;
  }

  sessionBootstrapPromise = new Promise<string | null>((resolve) => {
    const unsubscribe = onAuthStateChanged(
      auth,
      async (existingUser) => {
        unsubscribe();
        if (existingUser) {
          anonymousUidCache = existingUser.uid;
          resolve(existingUser.uid);
          return;
        }
        try {
          const cred = await signInAnonymously(auth);
          anonymousUidCache = cred.user.uid;
          resolve(cred.user.uid);
        } catch {
          // If Anonymous Auth provider is not toggled on in the Firebase project console yet,
          // resolve cleanly so the demo session and server-seeded Firestore queries proceed without error.
          resolve(anonymousUidCache);
        }
      },
      () => {
        unsubscribe();
        resolve(anonymousUidCache);
      }
    );
  });

  return sessionBootstrapPromise;
}

export function getActiveSessionUid(): string | null {
  return auth.currentUser?.uid || anonymousUidCache;
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid || anonymousUidCache || 'demo_session',
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous ?? true,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await ensureAnonymousOrActiveSession();
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
testConnection();

export async function signInWithGooglePopup() {
  return signInWithPopup(auth, googleProvider);
}

export async function signOutFirebase() {
  await signOut(auth);
  sessionBootstrapPromise = null;
  await ensureAnonymousOrActiveSession();
}

/**
 * P1-2(1) & P0-2(1): Validates image type/size, strips EXIF GPS/camera metadata via Canvas re-encoding,
 * and computes content SHA-256 hash before uploading to Cloud Storage.
 */
export async function processImageExifAndSha256(file: File): Promise<{
  cleanBlob: Blob;
  dataUrl: string;
  base64Data: string;
  mimeType: string;
  sha256: string;
  exifStripped: boolean;
}> {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(file.type)) {
    throw new Error('仅支持上传 JPG、PNG 或 WebP 格式的图片文件');
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new Error('图片文件大小不能超过 10MB');
  }

  const rawBuffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', rawBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const sha256 = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

  const bitmapUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = (err) => reject(err);
      el.src = bitmapUrl;
    });

    const maxDim = 960;
    let width = img.width || 640;
    let height = img.height || 480;
    if (width > maxDim || height > maxDim) {
      if (width >= height) {
        height = Math.round((height * maxDim) / width);
        width = maxDim;
      } else {
        width = Math.round((width * maxDim) / height);
        height = maxDim;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas 2D context unavailable');
    }
    ctx.drawImage(img, 0, 0, width, height);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.84);
    const base64Data = dataUrl.split(',')[1] || '';
    const cleanBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('图片重编码失败'))),
        'image/jpeg',
        0.84
      );
    });

    return {
      cleanBlob,
      dataUrl,
      base64Data,
      mimeType: 'image/jpeg',
      sha256,
      exifStripped: true,
    };
  } finally {
    URL.revokeObjectURL(bitmapUrl);
  }
}

export async function uploadCleanedImageToStorage(
  itemId: string,
  sha256: string,
  cleanBlob: Blob,
  fallbackDataUrl: string
): Promise<{ storagePath: string; imageUrl: string; uploadedToCloudStorage: boolean }> {
  await ensureAnonymousOrActiveSession();
  const storagePath = `items/${itemId}/${sha256.slice(0, 24)}.jpg`;
  try {
    const storageRef = ref(storage, storagePath);
    const uploadTaskPromise = (async () => {
      await uploadBytes(storageRef, cleanBlob, {
        contentType: 'image/jpeg',
        customMetadata: {
          sha256,
          exifStripped: 'true',
        },
      });
      const downloadUrl = await getDownloadURL(storageRef);
      return {
        storagePath,
        imageUrl: downloadUrl,
        uploadedToCloudStorage: true,
      };
    })();

    const timeoutPromise = new Promise<{
      storagePath: string;
      imageUrl: string;
      uploadedToCloudStorage: boolean;
    }>((_, reject) => {
      setTimeout(() => reject(new Error('Cloud Storage upload timeout (4s)')), 4000);
    });

    return await Promise.race([uploadTaskPromise, timeoutPromise]);
  } catch (err) {
    console.warn('Cloud Storage upload fallback (bucket rules or timeout):', err);
    return {
      storagePath,
      imageUrl: fallbackDataUrl,
      uploadedToCloudStorage: false,
    };
  }
}
