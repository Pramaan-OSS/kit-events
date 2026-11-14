CREATE TABLE event_categories (
 id uuid PRIMARY KEY, name text NOT NULL UNIQUE CHECK(length(name) BETWEEN 1 AND 80)
);
INSERT INTO event_categories VALUES
 ('a1000000-0000-4000-8000-000000000001','Community'),
 ('a1000000-0000-4000-8000-000000000002','Workshop'),
 ('a1000000-0000-4000-8000-000000000003','Performance');
CREATE TABLE events (
 id uuid PRIMARY KEY, title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
 venue text NOT NULL CHECK(length(venue) BETWEEN 1 AND 200),
 category_id uuid NOT NULL REFERENCES event_categories(id) ON DELETE RESTRICT,
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 timezone text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(ends_at>starts_at)
);
CREATE TABLE ticket_types (
 id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES events(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 price_cents integer NOT NULL CHECK(price_cents BETWEEN 0 AND 99999999),
 currency text NOT NULL CHECK(currency IN ('gbp','usd','eur','inr')),
 capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 100000),
 sales_start timestamptz NOT NULL, sales_end timestamptz NOT NULL,
 CHECK(sales_end>sales_start)
);
CREATE TABLE event_orders (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_users(id),
 type_id uuid NOT NULL REFERENCES ticket_types(id), quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 10),
 unit_cents integer NOT NULL CHECK(unit_cents>=0), currency text NOT NULL,
 status text NOT NULL CHECK(status IN ('held','paid','expired','cancelled','refunded','review')),
 hold_until timestamptz NOT NULL, request_key uuid NOT NULL,
 checkout_ref text UNIQUE, checkout_url text,
 email_status text NOT NULL DEFAULT 'not-sent' CHECK(email_status IN ('not-sent','sent','unknown')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,request_key)
);
CREATE INDEX event_orders_inventory ON event_orders(type_id,status,hold_until);
CREATE TABLE event_tickets (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES event_orders(id),
 code text NOT NULL UNIQUE CHECK(length(code)=64),
 cancelled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_tickets_order ON event_tickets(order_id);
CREATE TABLE event_checkins (
 ticket_id uuid PRIMARY KEY REFERENCES event_tickets(id),
 staff_id uuid NOT NULL REFERENCES app_users(id), checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE event_audit (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES event_orders(id),
 owner_id uuid NOT NULL REFERENCES app_users(id), action text NOT NULL, note text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
