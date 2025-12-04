import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const ALGORITHM = process.env.ENCRYPTION_ALGORITHM || 'aes-256-cbc';

const IV_LENGTH = process.env.ENCRYPTION_IV_LENGTH || 16; 

if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
    throw new Error('FATAL ERROR: ENCRYPTION_KEY must be exactly 32 characters long.');
}
if (!process.env.HASH_SECRET) {
    throw new Error('FATAL ERROR: HASH_SECRET is missing from env variables.');
}

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const HASH_SECRET = process.env.HASH_SECRET;

export const encrypt = (text) => {
    if (!text) return null;
    
    let iv = crypto.randomBytes(IV_LENGTH);
    
    let cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), iv);
    
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    return iv.toString('hex') + ':' + encrypted.toString('hex');
};

export const decrypt = (text) => {
    if (!text) return null;

    try {
        let textParts = text.split(':');
        let iv = Buffer.from(textParts.shift(), 'hex');
        let encryptedText = Buffer.from(textParts.join(':'), 'hex');
        
        let decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), iv);
        
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        
        return decrypted.toString();
    } catch (error) {
        console.error("Decryption Error:", error.message);
        return null;
    }
};

export const hashForSearch = (text) => {
    if (!text) return null;

    return crypto
        .createHash('sha256')
        .update(text + HASH_SECRET)
        .digest('hex');
};