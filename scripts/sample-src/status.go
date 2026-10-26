package main

// OrderStatus enumerates the order lifecycle states. The label is the copy
// rendered in the list table.
type OrderStatus string

const (
	StatusCreated   OrderStatus = "CREATED"
	StatusPaid      OrderStatus = "PAID"
	StatusShipped   OrderStatus = "SHIPPED"
	StatusCompleted OrderStatus = "COMPLETED"
	StatusCancelled OrderStatus = "CANCELLED"
)

// statusLabels maps each state to the human-readable copy shown in the UI.
var statusLabels = map[OrderStatus]string{
	StatusCreated:   "Pending payment",
	StatusPaid:      "Paid",
	StatusShipped:   "Shipped",
	StatusCompleted: "Completed",
	StatusCancelled: "Cancelled",
}

// Label returns the display copy for the status.
func (s OrderStatus) Label() string {
	if label, ok := statusLabels[s]; ok {
		return label
	}
	return string(s)
}
