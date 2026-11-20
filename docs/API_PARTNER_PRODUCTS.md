# Products API for outside apps

Any app authorized by VR Coffee can manage the products of a business with this API. The products are the same ones the business sees in Apartalo (no copies).

Base URL: `https://apartalo-core-9d633cdb9e1a.herokuapp.com/api/v1/farms`

## 1. Before you start

- Your app must be registered in the Firebase project **apartalo-10146** (ask VR Coffee). Users sign in there with Apple or Google.
- Send the user's Firebase ID token on every call: `Authorization: Bearer <token>`.
- Get the user's businesses from `POST /api/auth/session` (same token). Use each business's `farmId`, not the `BIZ-xxx` code.
- Only active **owners** and **staff** of a business can use its products.

## 2. Answers you can get

| Code | Meaning |
|---|---|
| 200, 201 | Done |
| 400 | Something is missing or wrong; `field` says which one |
| 401 | No token, or the token is not valid |
| 403 | The person is not a member of this business |
| 404 | The business, product or presentation does not exist in this business |
| 429 | Too many calls: max 60 per minute per person |
| 503 | Access could not be checked; try again |

The first call after a quiet time can take several seconds (the server wakes up). Retry with the same `Idempotency-Key`.

## 3. No double saves

Every `POST` needs a header `Idempotency-Key` (8 to 100 characters, for example a UUID made by your app for that action). If the same person sends the same key again, the API returns the first answer and saves nothing new. Keys are remembered for 24 hours.

## 4. Routes

### Products
- `GET /:farmId/products?offset=0&limit=20` → `{ items, total, hasMore }` (limit at most 50). Includes drafts and archived.
- `GET /:farmId/products/:productId` → one product.
- `POST /:farmId/products` with `{ name, description?, status? }` → 201. A new product starts as `draft`.
- `PATCH /:farmId/products/:productId` with any of `{ name, description, status }`.
  - `status`: `draft`, `active` (shown in the store) or `archived` (hidden). Products are never deleted.

### Presentations (a size with its price and stock)
- `POST /:farmId/products/:productId/presentations` with `{ packSize, unit, price, stock?, visible? }` → 201.
  - `price` is in soles (for example `25.90`).
  - `packSize` is more than 0.
  - `stock` is a whole number.
- `PATCH /:farmId/products/:productId/presentations/:presentationId` with any of `{ packSize, unit, price, stock, visible }`.

### Photos (up to 3 per presentation)
1. `POST .../presentations/:presentationId/photos/sign` with `{ mimeType }` (`image/jpeg`, `image/png` or `image/webp`) → `{ signedUrl, path }`.
2. `PUT` the image bytes to `signedUrl`.
3. `POST .../presentations/:presentationId/photos` with `{ path, mimeType }` and an `Idempotency-Key` → `{ id, url }`.

### Public products (no login)
- `GET /api/public/farms/:farmId/products?offset=0&limit=20` → `{ items, total, hasMore }`.
- Only approved businesses (404 otherwise), only `active` products and only visible presentations.
- Each item: `id, name, description` (max 300 characters), `currency, photoUrl, available`, and `presentations: [{ id, packSize, unit, price, available, photoUrl }]`. It never includes stock numbers, wholesale prices, lots or sales.
- Cached for 60 seconds. Max 120 calls per minute per IP.
- Your app decides which businesses it shows: the API does not know your app.

## 5. Shapes

```json
{
  "id": "uuid", "name": "Blend", "description": "", "status": "active", "currency": "PEN", "imageUrl": null,
  "presentations": [
    { "id": "uuid", "packSize": 250, "unit": "g", "price": 25.9, "stock": 4, "visible": true, "isDefault": false,
      "photos": [{ "id": "uuid", "url": "https://..." }] }
  ]
}
```

## 6. Not included yet

Deleting photos or presentations, product categories and coffee details, orders and payments.
