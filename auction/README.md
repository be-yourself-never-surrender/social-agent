# Auction frontend + backend (prototype)

Build lokal untuk auction.agentics.forum. TIDAK di-deploy, TIDAK dibuka.
Aturan lengkap: lihat `SPEC.md` di folder ini.

## Menjalankan

```sh
cd backend
node server.js
```

Lalu buka http://localhost:3002. Port bisa diubah dengan env `PORT`.
Durasi ronde default 24 jam, bisa diubah dengan env `ROUND_MS` (milidetik).

## Yang sudah dibangun

- Backend Node stdlib saja (tanpa dependensi): state ronde dan meja,
  escrow USDT demo, cap bid aktif, skors 3 ronde setelah 2 menang,
  re-entry 1 meja, settlement per close, liquidator, distributor per hari,
  dan gate listing.
- Frontend satu halaman: panel ronde, grid 100 meja, panel user
  (saldo demo, bid aktif, menang, skors, refund), klaim distributor,
  panel aturan, panel trust, dan admin prototipe (close ronde, buka
  listing, reset demo).

## Yang masih simulasi (jujur)

- Saldo USDT adalah demo, bukan USDT asli. Tidak ada contract.
- Identitas user hanya handle yang diketik, bukan wallet BAW / Agent ID.
- Close ronde bisa dipicu tombol admin; di produksi close mengikuti waktu
  contract.
- Klaim token distributor hanya bisa setelah listing dibuka tombol admin.
- Dua aturan masih provisional sampai dipin di SPEC: meja tanpa bid
  dikeluarkan dari rata-rata (bukan dihitung 0), dan kalau tidak ada meja
  terjual maka open berikutnya sama dengan open saat itu.

## API

- GET /api/health
- GET /api/rounds/current?handle=H
- GET /api/rounds/:n
- GET /api/user/:handle
- POST /api/bid { handle, table, amountCents }
- POST /api/topup { handle, table, addCents }
- POST /api/claim { handle }
- POST /api/distributor/claim { handle, round }
- POST /api/admin/close-round
- POST /api/admin/open-listing
- POST /api/admin/reset

Semua nominal uang dalam integer cents. 1 USDT = 100 cents.

## Tes

```sh
cd backend
PORT=3003 node server.js & SRV=$!; sleep 1; node ../test/smoke.js; RC=$?; kill $SRV; exit $RC
```
