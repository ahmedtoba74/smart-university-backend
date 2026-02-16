import mongoose from 'mongoose';

const dbConnection = async () => {
    const uri = process.env.MONGO_URI
        || process.env.DB_CONNECTION
            ?.replace('<username>', process.env.DB_USERNAME || '')
            ?.replace('<db_password>', process.env.DB_PASSWORD || '');
    if (!uri) {
        console.log('Database Error: MONGO_URI or DB_CONNECTION is required');
        process.exit(1);
    }
    return await mongoose
        .connect(uri)
        .then(() => {
            const db = mongoose.connection.db;
            const dbName = db?.databaseName ?? 'unknown';
            const host = mongoose.connection.host ?? 'unknown';
            console.log(`Database Connected successfully`);
            console.log(`  → Database name: "${dbName}"`);
            console.log(`  → Host: ${host}`);
        })
        .catch((err) => {
            console.log(`Database Error: ${err}`);
            process.exit(1); 
        });
};

export default dbConnection;