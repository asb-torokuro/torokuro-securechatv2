// In a real app, use bcrypt/argon2 and AES-256. 
// Here we simulate for the frontend demo as requested.

export const hashPassword = (password: string): string => {
  // Simple simulation of hashing for demo purposes (Base64 + Salt)
  return btoa(`salt_${password}_hash`);
};

export const verifyPassword = (password: string, hash: string): boolean => {
  return hashPassword(password) === hash;
};

export const encryptMessage = (text: string): string => {
  // Simulation: Rot13-ish or Base64 to show "scrambled" data in logs/storage
  try {
    return `ENC_${btoa(encodeURIComponent(text))}`;
  } catch (e) {
    return text;
  }
};

export const decryptMessage = (encryptedText: string): string => {
  if (!encryptedText.startsWith('ENC_')) return encryptedText;
  try {
    const core = encryptedText.replace('ENC_', '');
    return decodeURIComponent(atob(core));
  } catch (e) {
    return '**Decryption Error**';
  }
};

export const formatBytes = (bytes: number, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};