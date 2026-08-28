## 2026-08-25 — Console mengelola credential kanal dan membuktikan session

Scope: Channel Setup, bootstrap Telegram, Console Kanal, backup lokal, dan
credential utama/acceptance.

Changed: keberadaan credential lokal tidak lagi dipromosikan menjadi kesiapan
WhatsApp. Console menjalankan handshake bounded, membedakan session diterima,
ditolak, dan platform tidak terjangkau, mencatat waktu tanpa identifier, serta
membuka pemulihan saat ditolak. Refresh manual memaksa probe baru; polling
memakai hasil lima menit agar tidak membuka socket tiap 1,5 detik.
Token bot Telegram utama kini diverifikasi dan disimpan AES-GCM oleh Console,
terpisah dari bot acceptance. Migrasi menulis store sebelum menghapus satu
entri `.env` secara atomik; konflik sumber dan file link gagal tertutup.
Armada WhatsApp layanan kini mengikuti kontrak yang sama: Console menyimpan
metadata multi-akun terenkripsi, memasangkan QR per alias, memeriksa session,
serta menyediakan replace/revoke dan sakelar privat tanpa memantulkan nomor.
Lifecycle `pending|active|removing` mencegah runtime memuat akun setengah jadi;
mode setup memegang runtime lock utama. Instalasi nyata dimigrasikan melalui UI
dari tiga field WhatsApp legacy menjadi satu akun Console-managed aktif tanpa
mencabut session. Mutasi armada serta akses file credential kanal utama kini
diserialkan; polling melewati folder session yang sedang dimutasi dan reset
folder mengulang error filesystem Windows sementara. Ini menutup race antara
pairing/revoke/probe dan antara penulisan Telegram/WhatsApp pada store yang sama.
Surface Kanal kini memisahkan **Layanan** dan **Pengujian** sebagai tab halaman
yang simetris. Mode setup membuang sidebar satu-item, memakai label peran
Penguji→Harvy tanpa A/B, hanya menampilkan detail setelah tindakan **Kelola**,
dan memberi hasil warning ketika probe menemukan masalah. Pesan privasi global
dipindahkan dari sidebar ke konteks Audit. Epoch autentikasi mencegah respons restore lama
mengembalikan UI ke login setelah login operator baru berhasil. QR tidak lagi
diam sebagai kotak putih setelah request gagal: Console mengambil SVG sendiri,
menolak status/MIME/struktur yang tidak sah, lalu memasang SVG tervalidasi secara
inline. Retry otomatis dibatasi satu kali dan retry manual tidak mengulang pairing.

Verified: migrasi token utama nyata lulus tanpa refleksi; `.env` kini 0 entri,
bootstrap membaca store, backup drill aktual dan smoke Edge desktop/mobile
lulus, serta gerbang penuh 1870/1870 dalam 227 suite. Smoke interaksi baru lulus tiga run
beruntun; audit Edge read-only atas credential nyata kembali membuktikan
Telegram siap, akun Harvy tersimpan tetapi ditolak, dan akun penguji diterima tanpa
identifier/secret. Smoke Edge juga memblokir dua request QR lalu membuktikan
error terlihat dan payload panjang pulih sebagai QR inline. Audit Edge pada
pairing WhatsApp nyata membuktikan permukaan 320×320, opacity penuh, warna
hitam/putih, dan lebih dari dua ribu modul tanpa mencetak payload QR.
Smoke armada layanan juga lulus interaksi pengaturan dan layout desktop/mobile;
audit browser pada Console setup nyata membuktikan state legacy migratable lalu
state Console-managed setelah migrasi tanpa identifier.
Setelah pairing diperbaiki, audit read-only current build memberi ringkasan
acceptance WhatsApp `Sesi_valid`; akun layanan Console-managed juga lulus probe
langsung dengan status `ready`.

Not verified: restart/delivery WhatsApp layanan dari source Console-managed,
penambahan nomor layanan nyata kedua, dan journey WhatsApp penguji→Harvy.
