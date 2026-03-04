import { LibSQLStore } from "@mastra/libsql";
import { DynamoDBStore } from "@mastra/dynamodb";

export function getStorage(): LibSQLStore | DynamoDBStore {
  if (process.env.DYNAMODB_TABLE_NAME) {
    return new DynamoDBStore({
      name: "dynamodb",
      config: {
        id: 'storage-dynamodb',
        tableName: process.env.DYNAMODB_TABLE_NAME,
      },
    });
  } else {
    return new LibSQLStore({
      id: 'storage-memory',
      url: ":memory:"
    });
  }
}
