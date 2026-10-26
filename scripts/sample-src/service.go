package main

import (
	"errors"
	"fmt"
	"sync"
)

// OrderService enforces the order lifecycle rules. Each guard + error pair
// is a business rule the static analyzer records, and each status write is
// a verified transition.
type OrderService struct {
	mu     sync.Mutex
	seq    int64
	orders map[string]*Order
}

// NewOrderService seeds a few orders so the list page is never empty.
func NewOrderService() *OrderService {
	service := &OrderService{orders: map[string]*Order{}}
	service.seed("ORD1001", "Alice", "100.00", StatusCreated)
	service.seed("ORD1002", "Bob", "200.00", StatusPaid)
	service.seed("ORD1003", "Carol", "300.00", StatusShipped)
	service.seed("ORD1004", "David", "400.00", StatusCompleted)
	return service
}

func (s *OrderService) seed(orderNo, receiverName, amount string, status OrderStatus) {
	order := &Order{
		OrderNo:      orderNo,
		ReceiverName: receiverName,
		Amount:       amount,
		Status:       status,
	}
	s.store(order)
}

func (s *OrderService) store(order *Order) string {
	s.seq++
	order.ID = s.seq
	id := fmt.Sprintf("o-%d", s.seq)
	s.orders[id] = order
	return id
}

// Create stores a new order in the initial CREATED state.
func (s *OrderService) Create(order *Order) *Order {
	s.mu.Lock()
	defer s.mu.Unlock()
	order.OrderNo = fmt.Sprintf("ORD%06d", s.seq+1)
	order.Status = StatusCreated
	s.store(order)
	return order
}

// Get returns a single order by id.
func (s *OrderService) Get(orderID string) (*Order, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.find(orderID)
}

// List returns every order in insertion order of the seed plus new ones.
func (s *OrderService) List() []*Order {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*Order, 0, len(s.orders))
	for i := int64(1); i <= s.seq; i++ {
		if order, ok := s.orders[fmt.Sprintf("o-%d", i)]; ok {
			out = append(out, order)
		}
	}
	return out
}

// Pay moves CREATED orders to PAID.
func (s *OrderService) Pay(orderID string) (*Order, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	order, err := s.find(orderID)
	if err != nil {
		return nil, err
	}
	if order.Status != StatusCreated {
		return nil, errors.New("Current status does not allow this action")
	}
	order.Status = StatusPaid
	return order, nil
}

// Ship moves PAID orders to SHIPPED.
func (s *OrderService) Ship(orderID string) (*Order, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	order, err := s.find(orderID)
	if err != nil {
		return nil, err
	}
	if order.Status != StatusPaid {
		return nil, errors.New("Current status does not allow this action")
	}
	order.Status = StatusShipped
	return order, nil
}

// Complete moves SHIPPED orders to COMPLETED.
func (s *OrderService) Complete(orderID string) (*Order, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	order, err := s.find(orderID)
	if err != nil {
		return nil, err
	}
	if order.Status != StatusShipped {
		return nil, errors.New("Current status does not allow this action")
	}
	order.Status = StatusCompleted
	return order, nil
}

// Cancel moves CREATED or PAID orders to CANCELLED.
func (s *OrderService) Cancel(orderID string) (*Order, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	order, err := s.find(orderID)
	if err != nil {
		return nil, err
	}
	if order.Status == StatusShipped || order.Status == StatusCompleted {
		return nil, errors.New("Current status does not allow this action")
	}
	order.Status = StatusCancelled
	return order, nil
}

func (s *OrderService) find(orderID string) (*Order, error) {
	order, ok := s.orders[orderID]
	if !ok {
		return nil, errors.New("Order not found")
	}
	return order, nil
}
