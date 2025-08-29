import { LibSQLStore } from '@mastra/libsql';
import { DynamoDBStore } from '@mastra/dynamodb';

if (process.env.DYNAMODB_TABLE_NAME) {
  new DynamoDBStore({
    name: "dynamodb",
    config: {
      tableName: process.env.DYNAMODB_TABLE_NAME
    }
  });
} else {
  new LibSQLStore({
    url: "file::memory:"
  });
}
const telemetry = {};

export { telemetry };
