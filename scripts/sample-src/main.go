// Command order-demo is a small order-management backend built on
// github.com/hangtiancheng/yukino.go/libs/yukino_http.
//
// It is the reference backend the static analyzer parses: every endpoint,
// validation message, and status guard below is a fact the test-case
// pipeline relies on, so keep the copy exact when editing.
package main

import (
	"log"

	yukino "github.com/hangtiancheng/yukino.go/libs/yukino_http"
)

func main() {
	app := yukino.Default()

	handler := NewOrderHandler(NewOrderService())
	handler.Register(app)

	log.Println("order-demo listening on :8080")
	log.Fatal(app.Listen(":8080"))
}
