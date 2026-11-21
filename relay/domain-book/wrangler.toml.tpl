# Potato Workspace "Address book" Worker. Save this next to worker.js, then run: npx wrangler deploy
# The app fills in the two values below for you. Nothing secret is in this file: only the HASH of the key your PC holds.
name = "pm-address-book"
main = "worker.js"
compatibility_date = "2025-09-01"

# Your own name. It must already be a domain on your Cloudflare account.
routes = [{ pattern = "{{HOST}}", custom_domain = true }]

[vars]
SETUP_SECRET_SHA256 = "{{SECRET_SHA256}}"

[[durable_objects.bindings]]
name = "BOOK"
class_name = "Book"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Book"]
