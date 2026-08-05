# Panduan Spesifikasi & Rekayasa Virtual Terminal Sandbox Terisolasi

- **Status:** Riset Spesifikasi Rekayasa (Engineering Specification & Architecture)
- **Tanggal:** 6 Agustus 2026
- **Lokasi:** `docs/research/PANDUAN_SPESIFIKASI_SANDBOX_TERMINAL.md`
- **Tujuan:** Merancang arsitektur **Virtual Terminal Sandbox** dengan fitur **Network Egress Allowlist (hanya GitHub)**, **Command Blacklist & Network Inspection Rejection**, serta **Virtual Device Spec Spoofing**.

---

## Ringkasan Eksekutif

Membiarkan AI Agent menjalankan perintah terminal langsung pada host server adalah ancaman keselamatan tingkat tinggi (*Remote Code Execution & Information Disclosure*). Untuk mengamankannya, agen harus dieksekusi di dalam **Virtual Terminal Sandbox** yang memiliki isolasi berlapis:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             AGENT TERMINAL REQUEST                          │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. COMMAND & AST PARSER (Filter Command Blacklist & IP Inspection)          │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. VIRTUAL DEVICE SPEC SPOOFING (Procfs/Sysfs Mock & Fake Env)              │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. NETWORK EGRESS PROXY (Strict Allowlist: github.com & api.github.com)     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Network Egress Filtering (Network Allowlist — Hanya Akses GitHub)

Untuk memastikan agen hanya bisa mengakses domain spesifik (misalnya `github.com` dan `api.github.com`) dan tidak bisa mengakses internet lepas:

### A. Arsitektur Network Namespace (`netns`) & Egress Proxy
1. **Network Namespace Isolation (Linux `netns`):**
   - Proses sandbox dijalankan di dalam Linux Network Namespace tanpa akses internet langsung (*no default gateway*).
2. **Forward HTTP/HTTPS Proxy Berbasis Allowlist:**
   - Semua traffic HTTP/HTTPS sandbox dipaksa melewati local proxy (misal menggunakan Node.js custom HTTP Agent / Envoy / mitmproxy).
   - Ruleset Proxy:
     ```javascript
     const ALLOWED_HOSTS = new Set([
       "github.com",
       "api.github.com",
       "raw.githubusercontent.com",
       "codeload.github.com"
     ]);

     function validateEgress(targetHost) {
       if (!ALLOWED_HOSTS.has(targetHost.toLowerCase())) {
         throw new Error(`[ACCESS DENIED] Akses jaringan ke '${targetHost}' diblokir oleh Egress Sandbox Policy.`);
       }
     }
     ```
3. **DNS Sinkholing / Custom Resolver:**
   - Resolver DNS sandbox dikunci sehingga permintaan lookup ke domain di luar allowlist langsung dikembalikan sebagai `0.0.0.0` atau `ENOTFOUND`.

---

## 2. Command Blacklist & Rejection (Menolak Perintah IP Discovery & Peretas Sistem)

Mencegah agen menjalankan perintah pengintaian IP/jaringan (seperti `curl ifconfig.me`, `ip a`, `ping`) atau manipulasi sistem.

### A. Perintah yang Wajib Diblokir (Blacklist Patterns)
1. **Pemeriksaan IP & Jaringan:**
   - `curl ifconfig.me`, `curl ipinfo.io`, `curl icanhazip.com`, `curl api.ipify.org`
   - `ip a`, `ip route`, `ifconfig`, `netstat`, `ss`, `route`, `arp`
   - `ping`, `traceroute`, `nslookup`, `dig`, `nmap`, `nc`, `netcat`
2. **Pengintaian Jaringan File Sistem:**
   - `cat /proc/net/*`, `cat /proc/self/net/*`, `cat /sys/class/net/*`
3. **Perintah Destruktif / Host System Inspection:**
   - `reboot`, `shutdown`, `rm -rf /`, `chmod -R`, `chown`, `kill -9 1`

### B. Implementasi Validator (AST Command Parser)
Sebelum perintah dikirim ke runner terminal, validator memeriksa token perintah secara *fail-closed*:

```typescript
const FORBIDDEN_COMMANDS = new Set([
  "ip", "ifconfig", "netstat", "ss", "ping", "traceroute",
  "nslookup", "dig", "nmap", "nc", "netcat", "arp", "route"
]);

const FORBIDDEN_IP_LOOKUP_URLS = [
  "ifconfig.me", "ipinfo.io", "icanhazip.com", "ipify.org", "checkip.amazonaws.com"
];

const FORBIDDEN_PATHS = [
  "/proc/net", "/sys/class/net", "/etc/shadow", "/etc/passwd"
];

export function validateTerminalCommand(cmdString: string): { ok: boolean; error?: string } {
  const lowerCmd = cmdString.toLowerCase();

  // 1. Cek perintah IP/Jaringan terlarang
  for (const cmd of FORBIDDEN_COMMANDS) {
    if (new RegExp(`\\b${cmd}\\b`).test(lowerCmd)) {
      return { ok: false, error: `[SECURITY REJECTION] Perintah '${cmd}' tidak diizinkan di terminal virtual.` };
    }
  }

  // 2. Cek URL pengecekan IP Publik
  for (const url of FORBIDDEN_IP_LOOKUP_URLS) {
    if (lowerCmd.includes(url)) {
      return { ok: false, error: `[SECURITY REJECTION] Akses ke IP lookup service '${url}' dilarang.` };
    }
  }

  // 3. Cek Path sensitif
  for (const p of FORBIDDEN_PATHS) {
    if (lowerCmd.includes(p)) {
      return { ok: false, error: `[SECURITY REJECTION] Akses ke path internal '${p}' dilarang.` };
    }
  }

  return { ok: true };
}
```

---

## 3. Virtual Device Spec Spoofing (Spesifikasi Perangkat Virtual Palsu)

Untuk mencegah agen mengetahui detail hardware asli server (seperti jumlah core CPU, kapasitas RAM asli, hostname server, atau IP publik), sandbox menyediakan **Spesifikasi Perangkat Virtual (Virtual Spec Mocking)**.

### A. Environment Variables Virtual
Variabel lingkungan sistem diganti dengan nilai virtual yang konstan:

```bash
HOSTNAME="harvy-sandbox-v1"
USER="harvy"
HOME="/workspace"
SHELL="/bin/virtual-bash"
TERM="xterm-256color"
PATH="/usr/local/bin:/usr/bin:/bin"
```

### B. Virtual Procfs / Sysfs Mocking
Jika agen atau skrip di dalam terminal mencoba membaca detail hardware (misalnya lewat `cat /proc/cpuinfo` atau `free -m`), sandbox mengembalikan data virtual buatan:

1. **Virtual `/proc/cpuinfo` (Fake CPU):**
   ```
   processor       : 0
   vendor_id       : HarvyVirtualCPU
   cpu family      : 6
   model name      : Harvy Virtual Neural Processor v1 @ 2.40GHz
   cpu MHz         : 2400.000
   cache size      : 8192 KB
   ```
2. **Virtual `/proc/meminfo` (Fake RAM - Fixed 8GB):**
   ```
   MemTotal:        8192000 kB
   MemFree:         4096000 kB
   MemAvailable:    6144000 kB
   Buffers:          204800 kB
   Cached:          2048000 kB
   ```
3. **Virtual `uname -a` (Fake OS & Kernel):**
   ```
   Linux harvy-sandbox-v1 6.1.0-harvy-virtual #1 SMP PREEMPT_DYNAMIC UTC x86_64 GNU/Linux
   ```
4. **Virtual `/proc/net/dev` (Fake Network Interface):**
   ```
   Inter-|   Receive                                 |  Transmit
    face |bytes    packets errs drop fifo frame compressed|bytes    packets errs drop fifo colls carrier compressed
      lo:  1024       10    0    0    0     0          0     1024       10    0    0    0     0       0          0
    eth0: 65536      500    0    0    0     0          0    32768      300    0    0    0     0       0          0
   ```
   *(IP internal palsu: `10.240.0.15`, MAC: `02:42:AC:11:00:02`, tanpa IP Publik)*.

---

## 4. Matriks Ringkasan Implementasi Sandbox

| Lapangan Keamanan | Mekanisme Utama | Hasil yang Diperoleh |
|---|---|---|
| **Akses Network** | Egress Proxy Allowlist (`github.com`) + Network Namespace | Agen hanya bisa clone/push repo GitHub; akses IP lain diblokir total. |
| **Keamanan Perintah** | AST Command Filter + Blacklist Rejection | Perintah `curl ifconfig.me`, `ip a`, `ping` langsung ditolak di tingkat validator. |
| **Identitas Perangkat** | Procfs/Sysfs Virtual Mocking + Fake Env | Agen melihat spesifikasi virtual (Harvy V-CPU, 8GB V-RAM, Fake Local IP), menyembunyikan identitas server asli. |
| **Lingkungan Kerja** | In-Memory Virtual FS (`/workspace`) | Tidak ada persistensi berkas ke server host; aman dari kebocoran data. |
