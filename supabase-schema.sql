-- Supabase Schema for Food Vendor Ordering Engine
-- Run this in your Supabase SQL Editor if you want to store food orders in PostgreSQL

CREATE TABLE IF NOT EXISTS food_orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  reference TEXT UNIQUE NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_email TEXT,
  fulfillment_type TEXT NOT NULL DEFAULT 'DELIVERY', -- 'DELIVERY' or 'PICKUP'
  delivery_address TEXT,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  items_summary TEXT,
  subtotal NUMERIC NOT NULL DEFAULT 0,
  delivery_fee NUMERIC NOT NULL DEFAULT 0,
  total_amount NUMERIC NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'PAID',
  notes TEXT,
  vendor_name TEXT DEFAULT 'CRAVERS GRILL & SHAWARMA'
);

ALTER TABLE food_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public order inserts" 
  ON food_orders FOR INSERT 
  WITH CHECK (true);

CREATE POLICY "Allow public order reads" 
  ON food_orders FOR SELECT 
  USING (true);
