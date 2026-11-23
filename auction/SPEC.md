# Auction Sale System: Build Spec (DRAFT)

Sumber: diskusi 2026-11-05. Status: IN DESIGN, auction BELUM dibuka.
Build ini hanya UI/UX + backend. Tidak ada deploy produksi dan tidak ada
pembukaan sampai user bilang buka. Smart contract adalah workstream terpisah.

## Keputusan (pinned)

- Format: lelang first-price multi-meja, 5 ronde harian, 100 meja per ronde.
- Per meja satu lot. Bid tertinggi menang, bayar bid penuh. Tanpa refund
  selisih, tanpa penyesuaian ke harga rata-rata.
- Open hari berikut = rata-rata 100 harga penutupan hari itu (ratchet naik
  saja). Kelipatan bid = 10% dari open, dibulatkan ke atas.
- Cap per BAW: maks 2 bid aktif yang masih tertinggi (disalip = slot bebas).
  Total 2 menang = skors 3 ronde ke depan. Re-entry setelah skors = aktif
  1 meja, maks 1 lot. Hanya double-winner ronde 1 yang bisa balik di ronde 5.
  Maksimal 3 lot per BAW.
- Escrow per meja, mata uang USDT, bid fully funded. Bid TIDAK bisa di-cancel.
- Yang disalip bisa langsung claim USDT atau top-up di tengah ronde.
- Settlement tiap close: pembayaran pemenang diteruskan ke contract pusat /
  liquidator (menampung proceeds day 1-5). Yang kalah claim USDT saat close;
  yang kalah dan AFK tetap bisa claim USDT setelah close, tanpa hangus.
- Pemenang TIDAK menerima token transferable saat close (aturan claim langsung
  DIBATALKAN demi pasar). Pemenang dicatat, token hari itu dikirim ke
  distributor contract hari itu (5 distributor, 1 per hari), token baru bisa
  di-claim saat listing.
- Trust: semua kode contract publik dan terverifikasi. TIDAK ada fungsi claim
  ke dev wallet di distributor maupun liquidator. Hanya pemenang yang bisa
  claim token, USDT hanya mengalir ke pool yang dikunci, dev tidak bisa
  menarik dana user.
- Gas operasional (add liquidity, transfer escrow ke distributor/liquidator)
  dibayar dari dompet pribadi developer, bukan dari dana user.
- Pool: LP token di-BURN (permanen, bukan lock bertanggal).
- Pemasukan dev = fee saja. Tax trading token setelah publik: buy 1%, sell 2%;
  keduanya dibagi 50% dev wallet / 30% buy-back and burn / 20% treasury
  (penggunaan treasury belum ditentukan).
- Fee trading NFT 2,5% dari hasil penjual (pembeli bayar harga + gas saja);
  dibagi 70% likuiditas token / 20% dev wallet / 10% treasury.
- Filosofi: tanpa perlindungan pembeli. Overbid = salah bidder sendiri.
- Catatan verifier (bukan keputusan user): parameter fee harus immutable atau
  hard-capped di kode publik, karena fee yang bisa diubah seenaknya sama saja
  jalur tarik.

## Contoh (BUKAN keputusan, hanya ilustrasi)

- Supply 1 miliar; 200M auction + 200M likuiditas; 40M per hari; 400k per meja.
- Open day 1 $5, kelipatan $0,5. Contoh close: $18 / $17,5 / $12 / $14 / $20,
  rata-rata $16,37 menjadi open day 2, kelipatan $1,7.

## Masih terbuka (wajib dipin sebelum contract)

- Formula harga seed LP (rata-rata mana? berapa % proceeds masuk LP?).
- Mean vs median untuk open hari berikut (mean bisa dimanipulasi self-bid
  dengan net cost hampir nol).
- Meja kosong dihitung berapa dalam rata-rata (0 atau dikeluarkan).
- Tie-breaking saat bid tertinggi seri.
- Denominasi bid: diasumsikan per lot (per token akan membuat satu meja
  berharga jutaan dolar); perlu konfirmasi.
- Kapan distributor membuka claim (bersamaan LP jadi?).
- Sumber winner list: catatan backend vs hasil close on-chain (backend =
  titik trust terpusat).
- Penggunaan treasury (20% tax token + 10% fee NFT).

## Scope build ini

- UI/UX + backend untuk auction.agentics.forum, dibangun lokal di workspace,
  tidak di-deploy, tidak dibuka. Integrasi contract di-stub sampai contract
  dibangun.
