/**
 * Local FastAPI Media, EXIF Stripping, SHA-256 Hashing & Session Helper
 * (Replaces cloud Firebase SDK with 100% local FastAPI + SQLite/MySQL storage)
 */

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export const auth = {
  currentUser: null as null | { uid: string; email?: string | null; isAnonymous?: boolean },
};

export async function ensureAnonymousOrActiveSession(): Promise<string | null> {
  return 'local_campus_session';
}

export function getActiveSessionUid(): string | null {
  return 'local_campus_session';
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`[API Error] ${operationType} ${path || ''}:`, msg);
  throw new Error(msg);
}

export async function signInWithGooglePopup(): Promise<{
  user: {
    uid: string;
    email?: string | null;
    displayName?: string | null;
    photoURL?: string | null;
  };
}> {
  throw new Error('当前为本地 FastAPI 课程部署模式，请使用校园账号密码或顶部快捷角色登录。');
}

export async function signOutFirebase(): Promise<void> {
  return;
}

/**
 * Validates image type/size, strips EXIF GPS/camera metadata via Canvas re-encoding,
 * and computes content SHA-256 hash before uploading to FastAPI local storage.
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

/**
 * Uploads EXIF-stripped cleaned image to local FastAPI backend (/api/uploads/image).
 */
export async function uploadCleanedImageToStorage(
  itemId: string,
  sha256: string,
  _cleanBlob: Blob,
  fallbackDataUrl: string
): Promise<{ storagePath: string; imageUrl: string; uploadedToCloudStorage: boolean }> {
  try {
    const resp = await fetch('/api/uploads/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itemId,
        sha256,
        base64Image: fallbackDataUrl,
        mimeType: 'image/jpeg',
      }),
    });
    if (!resp.ok) {
      throw new Error(`Upload failed (${resp.status})`);
    }
    const data = await resp.json();
    return {
      storagePath: data.storagePath,
      imageUrl: data.imageUrl,
      uploadedToCloudStorage: true,
    };
  } catch (err) {
    console.warn('Local image upload fallback to DataURL:', err);
    return {
      storagePath: `uploads/${itemId}_${sha256.slice(0, 24)}.jpg`,
      imageUrl: fallbackDataUrl,
      uploadedToCloudStorage: false,
    };
  }
}
