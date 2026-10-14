#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN="demo-$$-$RANDOM"

CUSTOMER="11111111-0000-4000-8000-000000000001"
KEYBOARD="22222222-0000-4000-8000-000000000001"
MOUSE="22222222-0000-4000-8000-000000000002"
MONITOR="22222222-0000-4000-8000-000000000004"
WEBCAM="22222222-0000-4000-8000-000000000006"
DESK="22222222-0000-4000-8000-000000000010"

order_body() {
  local card="$1" items="$2" postal="${3-60601}"
  cat <<JSON
{
  "customerId": "$CUSTOMER",
  "shippingAddress": { "line1": "233 S Wacker Dr", "city": "Chicago", "postalCode": "$postal", "country": "US" },
  "items": $items,
  "payment": { "cardNumber": "$card" }
}
JSON
}

post_order() {
  local title="$1" key="$2" body="$3"
  echo
  echo "### $title"
  echo "POST /orders  Idempotency-Key: $key"
  curl -sS -w '\nHTTP %{http_code} in %{time_total}s\n' -X POST "$BASE_URL/orders" \
    -H 'content-type: application/json' \
    -H "Idempotency-Key: $key" \
    -d "$body"
}

ITEMS="[{\"productId\":\"$KEYBOARD\",\"quantity\":1},{\"productId\":\"$MOUSE\",\"quantity\":2}]"

post_order "4242: approved (201)" "$RUN-approved" "$(order_body 4242424242424242 "$ITEMS")"
post_order "Same key, same body: stored response replayed (201)" "$RUN-approved" "$(order_body 4242424242424242 "$ITEMS")"
post_order "Same key, different body (422)" "$RUN-approved" "$(order_body 4242424242424242 "[{\"productId\":\"$MOUSE\",\"quantity\":1}]")"
post_order "Any other valid card: approved (201)" "$RUN-other-card" "$(order_body 5555666677778888 "$ITEMS")"
post_order "0000: declined (402)" "$RUN-declined" "$(order_body 0000111122223333 "$ITEMS")"
post_order "1111: charged but response lost; recovered via status lookup (~10s, 201)" "$RUN-slow-charged" "$(order_body 1111222233334444 "$ITEMS")"
post_order "2222: provider never recorded the charge (~10s, 504)" "$RUN-not-charged" "$(order_body 2222333344445555 "$ITEMS")"
post_order "Webcam + standing desk: no single warehouse has both (409)" "$RUN-split" "$(order_body 4242424242424242 "[{\"productId\":\"$WEBCAM\",\"quantity\":1},{\"productId\":\"$DESK\",\"quantity\":1}]")"
post_order "100 monitors: insufficient stock (409)" "$RUN-too-many" "$(order_body 4242424242424242 "[{\"productId\":\"$MONITOR\",\"quantity\":100}]")"
post_order "Blank postal code: geocoding failure (422)" "$RUN-geocode" "$(order_body 4242424242424242 "$ITEMS" "")"
post_order "Duplicate productId: validation failure (422)" "$RUN-invalid" "$(order_body 4242424242424242 "[{\"productId\":\"$MOUSE\",\"quantity\":1},{\"productId\":\"$MOUSE\",\"quantity\":1}]")"

echo
echo "### GET /orders/:id for the first order"
ORDER_ID=$(curl -sS -X POST "$BASE_URL/orders" -H 'content-type: application/json' \
  -H "Idempotency-Key: $RUN-approved" -d "$(order_body 4242424242424242 "$ITEMS")" \
  | sed -E 's/^\{"id":"([^"]+)".*/\1/')
curl -sS -w '\nHTTP %{http_code}\n' "$BASE_URL/orders/$ORDER_ID"

echo
echo "To see 202 PAYMENT_UNKNOWN: docker compose stop payment-mock, re-run one order, then docker compose start payment-mock and watch the reconciler resolve it."
