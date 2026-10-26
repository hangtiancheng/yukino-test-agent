package main

import (
	"net/http"

	yukino "github.com/hangtiancheng/yukino.go/libs/yukino_http"
)

// OrderHandler exposes the order endpoints under /api/orders.
type OrderHandler struct {
	service *OrderService
}

// NewOrderHandler wires the handler to its service.
func NewOrderHandler(service *OrderService) *OrderHandler {
	return &OrderHandler{service: service}
}

// Register mounts every order endpoint on the application.
func (h *OrderHandler) Register(app *yukino.Application) {
	api := app.Router("/api/orders")
	api.Post("/create", h.Create)
	api.Post("/:id/pay", h.Pay)
	api.Post("/:id/ship", h.Ship)
	api.Post("/:id/complete", h.Complete)
	api.Post("/:id/cancel", h.Cancel)
	api.Get("/list", h.List)
	api.Get("/:id", h.Detail)
}

// Create validates the payload and stores a new order.
func (h *OrderHandler) Create(ctx *yukino.Context, _ func()) {
	var order Order
	if err := ctx.BindJSON(&order); err != nil {
		ctx.Throw(http.StatusBadRequest, "Invalid request body")
		return
	}
	if err := order.Validate(); err != nil {
		ctx.Throw(http.StatusBadRequest, err.Error())
		return
	}
	ctx.JSON(h.service.Create(&order))
}

// Pay moves the order to PAID when the lifecycle allows it.
func (h *OrderHandler) Pay(ctx *yukino.Context, _ func()) {
	order, err := h.service.Pay(ctx.Param("id"))
	if err != nil {
		ctx.Throw(http.StatusConflict, err.Error())
		return
	}
	ctx.JSON(order)
}

// Ship moves the order to SHIPPED when the lifecycle allows it.
func (h *OrderHandler) Ship(ctx *yukino.Context, _ func()) {
	order, err := h.service.Ship(ctx.Param("id"))
	if err != nil {
		ctx.Throw(http.StatusConflict, err.Error())
		return
	}
	ctx.JSON(order)
}

// Complete moves the order to COMPLETED when the lifecycle allows it.
func (h *OrderHandler) Complete(ctx *yukino.Context, _ func()) {
	order, err := h.service.Complete(ctx.Param("id"))
	if err != nil {
		ctx.Throw(http.StatusConflict, err.Error())
		return
	}
	ctx.JSON(order)
}

// Cancel moves the order to CANCELLED when the lifecycle allows it.
func (h *OrderHandler) Cancel(ctx *yukino.Context, _ func()) {
	order, err := h.service.Cancel(ctx.Param("id"))
	if err != nil {
		ctx.Throw(http.StatusConflict, err.Error())
		return
	}
	ctx.JSON(order)
}

// List returns every order.
func (h *OrderHandler) List(ctx *yukino.Context, _ func()) {
	ctx.JSON(h.service.List())
}

// Detail returns a single order.
func (h *OrderHandler) Detail(ctx *yukino.Context, _ func()) {
	order, err := h.service.Get(ctx.Param("id"))
	if err != nil {
		ctx.Throw(http.StatusNotFound, err.Error())
		return
	}
	ctx.JSON(order)
}
