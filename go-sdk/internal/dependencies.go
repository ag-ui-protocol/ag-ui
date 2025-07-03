// Package internal contains dependencies import file.
// This file ensures dependencies are preserved in go.mod during development.
// TODO: Remove this file once dependencies are actually used in implementation.
package internal

import (
	// Core Runtime Dependencies - keep in go.mod until used
	_ "github.com/evanphx/json-patch/v5"
	_ "github.com/google/uuid"
	_ "github.com/gorilla/websocket"
	_ "github.com/sirupsen/logrus"
	_ "golang.org/x/net/http2"
	_ "golang.org/x/sync/errgroup"
	_ "google.golang.org/grpc"
	_ "google.golang.org/protobuf/proto"

	// Testing Dependencies
	_ "github.com/stretchr/testify/assert"
)
