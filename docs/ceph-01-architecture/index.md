# Ceph 架構原理

## 什麼是 Ceph？

Ceph 是一個開源的**分散式儲存系統**，用一套系統同時提供三種儲存類型：

| 類型 | 介面 | 用途 |
|------|------|------|
| **Block** (RBD) | 虛擬磁碟 | VM 磁碟、資料庫 |
| **File** (CephFS) | POSIX 檔案系統 | 共享目錄、NAS |
| **Object** (RGW) | S3 / Swift API | 備份、靜態資料 |

**目前穩定版本：**

| 版本 | 代號 | 狀態 |
|------|------|------|
| v20 | Tentacle | 最新穩定（支援至 2027-11） |
| v19 | Squid | 穩定（支援至 2026-09） |
| v18 | Reef | 維護期結束 2026-03 |
| v17 | Quincy | EOL |

> Rook 與 Ceph 的版本對應關係詳見 [Rook 官方相容矩陣](https://rook.io/docs/rook/latest/Getting-Started/Prerequisites/prerequisites/)。

---

## 整體架構

```
┌────────────────────────────────────────────────────────────┐
│                     應用程式 / 客戶端                        │
│                                                            │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐    │
│  │ RBD      │  │ CephFS       │  │ RGW (S3/Swift)   │    │
│  │ (Block)  │  │ (File)       │  │ (Object)         │    │
│  └────┬─────┘  └──────┬───────┘  └────────┬─────────┘    │
│       │               │                    │              │
│       └───────────────┴────────────────────┘              │
│                          │                                 │
│              ┌───────────▼──────────────┐                 │
│              │    librados / RADOS       │                 │
│              │  （底層分散式物件儲存）    │                 │
│              └───────────┬──────────────┘                 │
│                          │                                 │
│  ┌──────────┐  ┌────────┴────────┐  ┌──────────────────┐ │
│  │ MON      │  │ OSD             │  │ MGR              │ │
│  │ (Monitor)│  │ (Object Storage)│  │ (Manager)        │ │
│  └──────────┘  └─────────────────┘  └──────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

---

## 核心元件

### MON（Monitor）

- **職責**：維護整個 cluster 的 **Cluster Map**（地圖），是所有節點的共識基礎
- 使用 **Paxos** 演算法確保多個 MON 之間達成一致
- 不儲存實際資料，只維護元資料（誰在哪、狀態如何）
- 奇數部署（至少 3 個），多數派存活就能運作

```
MON 維護 5 種地圖：
├── Monitor Map  → 所有 MON 的 IP / 狀態
├── OSD Map      → 所有 OSD 的狀態（up/down/in/out）
├── PG Map       → Placement Group 的狀態
├── CRUSH Map    → 儲存拓撲和資料分佈規則
└── MDS Map      → Metadata Server 狀態（CephFS 用）
```

### OSD（Object Storage Daemon）

- **職責**：實際存放資料的 daemon，每顆磁碟跑一個 OSD
- 負責資料的讀寫、複製、recovery、scrubbing
- OSD 之間**直接通訊**做資料複製，不需要中央節點
- 通報自己和鄰近 OSD 的狀態給 MON

```
一個寫入流程：
Client → Primary OSD（計算位置）
              │
              ├── 寫入本地
              ├── 複製到 Secondary OSD
              └── 複製到 Tertiary OSD
              ↓
          ack 給 Client
```

### MGR（Manager）

- **職責**：Cluster 的監控和協調，提供 Dashboard、REST API、Prometheus metrics
- 支援 module 擴展（dashboard、prometheus、pg_autoscaler 等）
- Active + Standby 部署，active 掛掉自動切換

### MDS（Metadata Server）

- **職責**：僅 CephFS 需要，管理檔案系統的 **元資料**（目錄結構、權限、inode）
- 實際檔案資料還是存在 OSD，MDS 只管「在哪裡」
- 支援多個 Active MDS 水平擴展（大規模場景）

### RGW（RADOS Gateway）

- **職責**：提供 S3 / Swift 相容的 Object Storage API
- 是一個 HTTP daemon，把 S3 request 轉換成 RADOS 操作
- 支援多租戶、bucket policy、lifecycle 規則

---

## 最核心的設計：CRUSH 演算法

CRUSH（Controlled Replication Under Scalable Hashing）是 Ceph 最關鍵的設計，決定**資料存在哪裡**。

### 傳統做法的問題

```
傳統：Client → 查詢中央位置表 → 找到 OSD → 讀寫
                   ↑
           單點瓶頸、擴展困難
```

### CRUSH 的做法

```
Ceph：Client → CRUSH 演算法（本機計算）→ 直接找到 OSD → 讀寫
         ↑
  不需要中央查詢，每個 Client / OSD 都能計算
```

### CRUSH 計算流程

```
輸入：Pool ID + Object Name
         ↓
    Hash(Object Name)
         ↓
    PG ID = Hash % PG 數量
         ↓
    CRUSH(PG ID + CRUSH Map) → 選出 OSD 列表
         ↓
    Primary OSD + Replica OSDs
```

### Failure Domain（故障域）

CRUSH 保證副本分散在不同的故障域，避免一個故障影響所有副本：

```yaml
# CRUSH 規則範例：副本分散在不同 Host
failure_domain: host    # 每個副本在不同機器
# 或
failure_domain: rack    # 每個副本在不同機架
# 或
failure_domain: zone    # 每個副本在不同機房（跨 AZ）
```

---

## Placement Group（PG）

PG 是 Ceph 資料管理的基本單位，介於 Object 和 OSD 之間的抽象層：

```
多個 Object → 對應到一個 PG → PG 對應到一組 OSD
```

**為什麼需要 PG？**
- Object 數量可能有幾億個，直接追蹤太貴
- PG 數量固定（幾百到幾千個），管理成本低
- OSD 加入/移除時，只需要移動 PG，不是逐一移動 Object

**PG 數量建議：**
```
PG 數 ≈ (OSD 數 × 100) / 副本數
# 例：10 個 OSD，3 副本
# PG ≈ (10 × 100) / 3 ≈ 333 → 取最近的 2 的冪次方 = 256 或 512
```

---

## 副本 vs Erasure Coding

### 比較表

| | 副本模式（Replication） | Erasure Coding（EC） |
|--|----------------------|---------------------|
| **設定範例** | `size: 3` | `k=4, m=2`（4 資料 + 2 校驗） |
| **容量效率** | 1/3（3 副本需 3 倍空間） | ~67%（k/(k+m) = 4/6） |
| **可容忍故障** | size-min_size 個 OSD | m 個 chunk 損失 |
| **讀取效能** | 高（任一副本可讀） | 中（需要合並 chunk） |
| **寫入效能** | 高 | 中（計算校驗塊有額外開銷） |
| **Recovery 速度** | 快（直接複製整份資料） | 慢（需要計算重建） |
| **支援 RBD** | ✅ 完整支援 | ⚠️ 部分限制 |
| **適用場景** | VM 磁碟、Database（效能優先） | 冷資料、Object Storage（容量優先） |
| **Rook 設定** | `replicated: { size: 3 }` | `erasureCoded: { dataChunks: 4, codingChunks: 2 }` |

### 故障域（failureDomain）選擇

| failureDomain | 副本分散到 | 可容忍 | 典型環境 |
|--------------|----------|--------|---------|
| `osd` | 不同 OSD（同一台機器） | 單顆磁碟故障 | 測試環境 |
| `host`（推薦） | 不同 Node | 整台機器故障 | 一般生產 |
| `rack` | 不同機架 | 整個機架斷電 | 大型機房 |
| `zone` | 不同可用區 | 整個 AZ 故障 | 多雲 / 跨機房 |

### 副本模式（Replication）

```
size: 3  → 同一份資料存 3 份
min_size: 2  → 至少 2 份可讀才提供服務
```

- 容量效率：1/3（存 1TB 需要 3TB 空間）
- 效能好，Recovery 快
- **KubeVirt VM 磁碟推薦用這個**

### Erasure Coding（EC）

```
k=4, m=2  → 分成 4 個資料塊 + 2 個校驗塊
           → 任意 2 個塊損失都能恢復
```

- 容量效率：4/6 ≈ 67%（比副本好很多）
- 計算開銷較高，不支援 RBD 的所有功能
- 適合冷資料、大檔案、Object Storage

---

## 隨堂測驗 {#quiz}

::: details 測驗 1：MON 的數量為什麼要是奇數？
**答案：** MON 使用 Paxos 演算法需要**多數派**（majority）同意才能做決策。

- 3 個 MON → 可容忍 1 個故障（2/3 多數派）
- 5 個 MON → 可容忍 2 個故障（3/5 多數派）
- 4 個 MON → 可容忍 1 個故障（3/4 多數派），但比 3 個 MON 只多一點容錯，不值得

奇數可以最大化容錯數量。
:::

::: details 測驗 2：CRUSH 演算法解決了什麼問題？
**答案：** 解決了**中央位置查詢瓶頸**的問題。

傳統儲存系統需要查詢中央元資料服務器才知道資料在哪裡，這個服務器會成為瓶頸。CRUSH 讓每個 Client 和 OSD 都能**本機計算**資料位置，直接找到對應 OSD，完全去中央化。
:::

::: details 測驗 3：PG 是什麼？為什麼需要它？
**答案：** PG（Placement Group）是 Object 和 OSD 之間的**抽象層**。

需要它是因為一個 Ceph Cluster 可能有幾億個 Object，如果 Cluster 要追蹤每個 Object 的位置，成本太高。PG 把大量 Object 分組，Cluster 只需要追蹤幾百到幾千個 PG 的位置，大幅降低管理複雜度。
:::

---

## 實作：認識 Ceph Cluster 狀態

如果你有一個跑起來的 Ceph Cluster（透過 Rook），可以用 toolbox 查看：

```bash
# 進入 Rook toolbox
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- bash

# 查看 Cluster 整體狀態
ceph status
# HEALTH_OK 表示正常

# 查看所有 OSD
ceph osd tree

# 查看 CRUSH Map
ceph osd crush dump

# 查看所有 PG 狀態
ceph pg stat

# 查看 Pool 列表
ceph osd pool ls detail

# 查看 Cluster 容量
ceph df
```

**正常的 `ceph status` 輸出長這樣：**

```
  cluster:
    id:     xxxxx
    health: HEALTH_OK

  services:
    mon: 3 daemons, quorum a,b,c
    mgr: a(active), standbys: b
    osd: 9 osds: 9 up, 9 in

  data:
    pools:   3 pools, 96 pgs
    objects: 1.23k objects, 4.5 GiB
    usage:   14 GiB used, 286 GiB / 300 GiB avail
    pgs:     96 active+clean
```
