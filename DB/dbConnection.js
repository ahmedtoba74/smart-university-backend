import mongoose from "mongoose";

const dbConnection = async () => {
    return await mongoose
        .connect(
            process.env.DB_CONNECTION.replace(
                "<username>",
                process.env.DB_USERNAME,
            ).replace("<db_password>", process.env.DB_PASSWORD),
        )
        .then(() => {
            console.log(`Database Connected successfully`);
        })
        .catch((err) => {
            console.log(`Database Error: ${err}`);
            process.exit(1);
        });
};

export default dbConnection;
