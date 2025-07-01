#!/bin/bash

## THIS IS A TEMPORARY SCRIPT TO COPY EXAMPLE SERVERS, 
## RUN THIS WHEN REBASING ETC TO MAKE SURE CHANGES DONT GET LOST 

GIT_ROOT=$(git rev-parse --show-toplevel)
INTEGRATIONS_DIR="$GIT_ROOT/typescript-sdk/integrations"

# agno example already put in correct place from an outside repository
# so no need to worry about changes in this repo at the time. 
# changes not required for vercel

## SERVER
echo "Copying server-start-all-features"
rm -rf "$INTEGRATIONS_DIR/server-starter-all-features/example-server"
cp -r "$INTEGRATIONS_DIR/server-starter-all-features/server/python" "$INTEGRATIONS_DIR/server-starter-all-features/example-server"

## LANGRAPH
echo "Copying langgraph"
rm -rf "$INTEGRATIONS_DIR/langgraph/example-server"
cp -r "$INTEGRATIONS_DIR/langgraph/examples" "$INTEGRATIONS_DIR/langgraph/example-server"

## MASTRA
echo "Copying mastra"
rm -rf "$INTEGRATIONS_DIR/mastra/example-server"
cp -r "$INTEGRATIONS_DIR/mastra/example" "$INTEGRATIONS_DIR/mastra/example-server"

## LLAMAINDEX
echo "Copying llamaindex"
rm -rf "$INTEGRATIONS_DIR/llamaindex/example-server"
cp -r "$INTEGRATIONS_DIR/llamaindex/server-py" "$INTEGRATIONS_DIR/llamaindex/example-server"

## CREWAI
echo "copying crewai"
rm -rf "$INTEGRATIONS_DIR/crewai/example-server"
cp -r "$INTEGRATIONS_DIR/crewai/python" "$INTEGRATIONS_DIR/crewai/example-server"

