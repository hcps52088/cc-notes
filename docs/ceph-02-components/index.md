# Ceph 核心元件深入解析

## 元件全覽

```
┌─────────────────────────────────────────────────────────────┐
│                      Ceph Cluster                            │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                 │
│  │  MON     │  │  MON     │  │  MON     │  ← 奇數，≥3     │
│  │ (Monitor)│  │ (Monitor)│  │ (Monitor)│    負責共識      │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                 │
│       └─────────────┴─────────────┘                        │
│                          │ Cluster Map                      │
│  ┌───────────────────────▼──────────────────────────────┐  │
│  │                   OSD Layer                           │  │
│  │  ┌─────┐  ┌─────┐  ┌─────┐  ┌─────┐  ┌─────┐      │  │
│  │  │ OSD │  │ OSD │  │ OSD │  │ OSD │  │ OSD │      │  │
│  │  │  0  │  │  1  │  │  2  │  │  3  │  │  4  │      │  │
│  │  │/dev/│  │/dev/│  │/dev/│  │/dev/│  │/dev/│      │  │
│  │  │sdb  │  │sdc  │  │sdb  │  │sdc  │  │sdb  │      │  │
│  │  └─────┘  └─────┘  └─────┘  └─────┘  └─────┘      │  │
│  │   Node1    Node1    Node2    Node2    Node3           │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │  MGR     │  │  MGR     │  │  MDS     │  │  RGW     │  │
│  │ (Active) │  │(Standby) │  │(CephFS)  │  │(Object)  │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## MON（Monitor）

### 職責

MON 是 Ceph 的**神經中樞**，維護所有節點都認同的 Cluster Map。

沒有 MON，Ceph 就不知道「哪個 OSD 負責哪些資料」，整個 Cluster 就癱瘓。

### Cluster Map 的五張子地圖

| 地圖 | 內容 | 何時更新 |
|------|------|---------|
| **Monitor Map** | 所有 MON 的 IP、port、狀態 | MON 加入/離開 |
| **OSD Map** | 所有 OSD 的狀態（up/down/in/out）、Host 對應 | OSD 狀態改變 |
| **PG Map** | 每個 Placement Group 的狀態和統計 | PG 狀態改變 |
| **CRUSH Map** | 儲存拓撲（Node、Rack、Zone 層級）和資料分佈規則 | 手動修改或 OSD 增減 |
| **MDS Map** | MDS daemon 的狀態（CephFS 用） | MDS 狀態改變 |

### Paxos 共識機制

```
Client 或 OSD 要更新 Cluster Map
            │
            ▼
    向 Primary MON 提交
            │
            ▼
Primary MON 廣播給其他 MON
            │
            ▼
超過半數 MON 同意（多數派）
            │
            ▼
  更新並廣播新的 Cluster Map
```

**為什麼要多數派？** 防止網路分區（split-brain）。如果 5 個 MON 分成 3+2，只有 3 那邊能繼續服務，2 那邊因為湊不到多數而停止，避免兩邊各自更新產生衝突。

### 部署建議

| 環境 | MON 數量 | 可容忍故障 |
|------|---------|-----------|
| 測試 | 1 | 0 |
| 小型生產 | 3 | 1 |
| 大型生產 | 5 | 2 |

```bash
# 查看 MON 狀態
ceph mon stat
ceph mon dump

# 查看 Quorum（多數派成員）
ceph quorum_status

# 在 Rook 中查看
kubectl -n rook-ceph get pod -l app=rook-ceph-mon
```

### MON 的資料存放

MON 自己的資料（Cluster Map 歷史）存在 `/var/lib/ceph/mon/` 下，使用 RocksDB 格式。這個目錄很小（幾 GB），但非常重要。

---

## OSD（Object Storage Daemon）

### 職責

OSD 是 Ceph 實際**存放資料的地方**，每顆磁碟對應一個 OSD process。

一個 OSD 同時負責：
1. 存放自己負責的 PG 資料
2. 複製資料到其他 OSD（Replica）
3. 心跳偵測和回報給 MON
4. 資料 Recovery（OSD 故障後自動補回）
5. Scrubbing（定期掃描驗證資料完整性）

### BlueStore（OSD 的儲存引擎）

從 Ceph Nautilus 開始預設使用 **BlueStore**，直接管理原始 block device，不依賴作業系統 filesystem。Ceph Reef（v18）之後已完全移除舊的 FileStore，**BlueStore 是唯一支援的儲存引擎**。

```
舊版（Filestore，已棄用）：
OSD → OS Filesystem (ext4/xfs) → Raw Disk
        ↑ 多一層，有額外開銷

BlueStore（現行唯一引擎）：
OSD → Raw Disk（直接操作）
        ↑ 更低延遲，支援 Checksum、壓縮、加密
```

BlueStore 在磁碟上分三個區域：
- **Block（主要）**：存放 object 資料
- **Block.db**：存放 RocksDB 元資料（可放在 SSD 加速）
- **Block.wal**：Write-Ahead Log（可放在 NVMe 加速）

```bash
# 查看 OSD 狀態
ceph osd stat
ceph osd tree          # 顯示 OSD 的 CRUSH 層級（Node、Rack）

# 查看特定 OSD 的詳細資訊
ceph osd info 0

# 查看所有 OSD 的效能統計
ceph osd perf

# 在 Rook 中查看
kubectl -n rook-ceph get pod -l app=rook-ceph-osd
```

### OSD 狀態說明

```
OSD 的狀態由兩個維度組合：

up / down：OSD process 是否在線
in / out：OSD 是否在 CRUSH Map 裡（是否負責資料）

組合：
┌────────┬──────────────────────────────────────────────────┐
│ up+in  │ 正常狀態，負責資料並且在線                         │
│ up+out │ 在線但不負責資料（新加入或被踢出的過渡狀態）         │
│down+in │ 離線但還在 CRUSH Map，Ceph 等待它回來（還不 recover）│
│down+out│ 離線且被移出 CRUSH Map，資料開始 recover 到其他 OSD │
└────────┴──────────────────────────────────────────────────┘
```

### PG（Placement Group）與 OSD 的關係

```
每個 OSD 負責多個 PG：

OSD 0：PG 1.1, 1.4, 1.7, 2.2 ...（Primary）
         PG 1.2, 1.5, 2.1 ...（Replica）

OSD 1：PG 1.2, 1.5, 2.1 ...（Primary）
         PG 1.1, 1.4, 2.2 ...（Replica）

一個 PG 的資料分佈在 size 個 OSD 上：
PG 1.1 → [OSD 0 (Primary), OSD 3 (Replica), OSD 7 (Replica)]
```

### Recovery 流程

```
OSD 3 故障（down+in）
        │
等待 mon osd down out interval（預設 600 秒）
        │
OSD 3 變成 down+out
        │
Ceph 計算哪些 PG 受影響
        │
找到其他 OSD 補足缺少的副本
        │
資料 Recovery 完成，PG 回到 active+clean
```

```bash
# 查看 Recovery 進度
ceph status   # 看 pgs: X active+recovering
ceph pg stat
```

---

## MGR（Manager）

### 職責

MGR 提供 Ceph 的**監控、管理、外部整合**功能。它本身不存資料，而是提供各種服務和統計：

- **Prometheus 指標**：暴露 Ceph metrics，讓 Grafana 畫圖
- **Dashboard**：Web UI 管理介面
- **REST API**：程式化管理介面
- **pg_autoscaler**：自動調整 PG 數量
- **balancer**：自動平衡 OSD 負載

### Active + Standby

MGR 採用 Active/Standby 模式：
- Active MGR 提供所有服務
- Standby MGR 就緒等待，Active 掛掉後自動接管

```bash
# 查看 MGR 狀態
ceph mgr stat
ceph mgr dump

# 查看所有 MGR module
ceph mgr module ls

# 啟用 Prometheus module
ceph mgr module enable prometheus

# 啟用 Dashboard module
ceph mgr module enable dashboard
ceph dashboard create-self-signed-cert
ceph dashboard ac-user-create admin -i <password-file> administrator

# 在 Rook 中查看
kubectl -n rook-ceph get pod -l app=rook-ceph-mgr
```

### Rook 的 Dashboard 存取

```bash
# 取得 Dashboard 的 Service
kubectl -n rook-ceph get svc rook-ceph-mgr-dashboard

# Port-forward 到本機
kubectl -n rook-ceph port-forward svc/rook-ceph-mgr-dashboard 8443:8443 &

# 取得預設 admin 密碼
kubectl -n rook-ceph get secret rook-ceph-dashboard-password \
  -o jsonpath="{['data']['password']}" | base64 -d

# 開啟瀏覽器
open https://localhost:8443
```

---

## MDS（Metadata Server）

### 職責

MDS **只有 CephFS 才需要**。它管理檔案系統的**元資料**：
- 目錄結構（哪些檔案在哪個目錄）
- 檔案屬性（大小、時間、權限、inode）
- 檔案鎖定（flock，讓多個 Client 安全並發）

**實際的檔案資料（內容）不在 MDS，還是在 OSD。** MDS 只管「在哪裡」，不管「是什麼」。

### 元資料和資料的分離

```
Client 讀取 /data/file.txt：

1. Client → MDS：/data/file.txt 在哪？
2. MDS → Client：在 OSD 5、OSD 8、OSD 12 的 PG 3.7
3. Client → OSD 5（直接）：給我資料
4. OSD 5 → Client：這是你的資料

                    MDS 只參與步驟 1、2
                    實際資料傳輸不經過 MDS
```

這個設計讓 MDS 不會成為瓶頸，資料傳輸直接在 Client 和 OSD 之間進行。

### 多 Active MDS（大規模場景）

```yaml
# Rook CephFilesystem
spec:
  metadataServer:
    activeCount: 3        # 3 個 Active MDS，每個負責部分目錄樹
    activeStandby: true   # 每個 Active 都有 Standby
```

多個 Active MDS 透過**目錄樹分割（subtree partitioning）**各自負責不同目錄，實現水平擴展。

```bash
# 查看 MDS 狀態
ceph mds stat
ceph fs status          # 查看 CephFS 和 MDS 狀態

# 在 Rook 中查看
kubectl -n rook-ceph get pod -l app=rook-ceph-mds
```

---

## RGW（RADOS Gateway）

### 職責

RGW 是 Ceph 的 **Object Storage 閘道**，把 HTTP S3 / Swift 請求轉換成 RADOS 操作。

```
S3 Client（aws cli / SDK）
      │ HTTP PUT/GET/DELETE
      ▼
   RGW（FastCGI / Beast HTTP daemon）
      │ librados API
      ▼
   RADOS（OSD 上的資料）
```

### 支援的 API

| API | 相容性 | 常用工具 |
|-----|--------|---------|
| S3 v2 / v4 | 高度相容 | `aws s3`、boto3、MinIO Client |
| OpenStack Swift | 支援 | python-swiftclient |

### S3 概念對應 RADOS

| S3 概念 | Ceph 概念 |
|---------|----------|
| Bucket | RADOS Pool 的邏輯分區 |
| Object | RADOS Object |
| Access Key / Secret | Ceph User 金鑰 |
| Region | RGW Zone / ZoneGroup |

### Multisite（跨機房同步）

RGW 支援多站點同步，讓兩個地理位置的 Ceph Cluster 互相複製 Object：

```
東部機房 Ceph ←──── 雙向同步 ────→ 西部機房 Ceph
   RGW Zone 1                          RGW Zone 2
```

```bash
# 查看 RGW 狀態
ceph osd pool ls | grep rgw   # 查看 RGW 使用的 Pool

# 建立 RGW user
radosgw-admin user create \
  --uid=alice \
  --display-name="Alice" \
  --access-key=AKID123 \
  --secret=secret123

# 用 aws cli 測試
aws s3 mb s3://my-bucket \
  --endpoint-url http://rook-ceph-rgw-my-store.rook-ceph:80

aws s3 cp test.txt s3://my-bucket/ \
  --endpoint-url http://rook-ceph-rgw-my-store.rook-ceph:80

# 在 Rook 中查看
kubectl -n rook-ceph get pod -l app=rook-ceph-rgw
```

---

## 各元件部署方式比較

| 元件 | 部署類型 | 數量 | 高可用機制 | 無此元件的影響 |
|------|---------|------|-----------|------------|
| **MON** | 靜態 Pod | 奇數（3/5） | Paxos 選主 | Cluster 無法運作 |
| **OSD** | 每磁碟一個 Pod | N（磁碟數量） | CRUSH 副本分散 | 部分資料降級，超閾值不可用 |
| **MGR** | Deployment | 2（Active+Standby） | Active/Standby 自動切換 | 監控停止，Dashboard 不可用 |
| **MDS** | Deployment | 至少 1（可多個） | Active+Standby | CephFS 不可用（RBD/RGW 不受影響） |
| **RGW** | Deployment | 1+（可多個） | 多實例 + LB | Object Storage 不可用 |

## 各元件資源消耗參考

| 元件 | CPU | 記憶體 | 磁碟 |
|------|-----|--------|------|
| MON | 低 | 1–2 GiB（map 隨 cluster 成長） | 10–50 GiB |
| OSD | 中（隨 I/O 增加） | 4–6 GiB/OSD | 整顆資料磁碟 |
| MGR | 低 | 1–2 GiB | 少量 |
| MDS | 中（元資料在記憶體） | 1–4 GiB | 少量 |
| RGW | 中（隨請求數增加） | 1–2 GiB | 少量 |

---

## 隨堂測驗 {#quiz}

::: details 測驗 1：OSD 的 up/down 和 in/out 分別代表什麼？有什麼實際影響？
**答案：**

- **up/down**：OSD process 是否正在運行（網路連線）
- **in/out**：OSD 是否在 CRUSH Map 裡負責存放資料

實際影響：
- `down+in`：OSD 剛掛掉，Ceph 認為它可能很快回來，暫時不開始 Recovery（等 `mon osd down out interval` 時間）
- `down+out`：確認 OSD 不會回來，CRUSH 把它的 PG 轉移給其他 OSD，開始 Recovery

這個兩階段設計避免 OSD 短暫重啟（例如重開機）就觸發大量 Recovery，浪費網路頻寬。
:::

::: details 測驗 2：MDS 負責儲存 CephFS 的哪些資料？哪些不是？
**答案：**

MDS 負責（**元資料**）：
- 目錄樹結構（哪些目錄在哪裡）
- 檔案的 inode（大小、時間戳記、權限、owner）
- 檔案鎖定狀態

MDS 不負責（**實際檔案內容**）：
- 檔案的位元組資料（這些直接在 OSD 上）

設計這樣的原因：把元資料查詢（小但頻繁）和資料傳輸（大量）分開，讓 Client 查到位置後直接找 OSD 取資料，MDS 不會成為傳輸瓶頸。
:::

::: details 測驗 3：為什麼 MGR 採用 Active + Standby 而不是多個 Active 同時工作？
**答案：** MGR 提供的服務（Dashboard、Prometheus metrics、pg_autoscaler）需要對整個 Cluster 有**一致的全局視角**。如果兩個 Active MGR 同時運行，它們各自做決策可能衝突（例如兩個都在調整同一個 PG 的數量）。

Active/Standby 模式確保同一時間只有一個 MGR 做決策，避免競爭條件。Standby 只是熱備份，Active 故障時立刻接管，不會中斷服務超過幾秒鐘。
:::

::: details 測驗 4：Cluster 有 5 個 MON，最多可以容忍幾個同時故障？如果故障的是 Primary MON 怎麼辦？
**答案：**

5 個 MON → 多數派 = 3 → 最多可容忍 **2 個**故障。

如果 Primary MON 故障，Paxos 會在剩餘 MON 中重新選出一個 Primary（leader election），整個過程通常幾秒內完成。Client 會短暫連不上 MON，重試後連到新的 Primary，操作繼續。
:::

---

## 實作：深入觀察各元件

```bash
# 進入 Rook Toolbox
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- bash

# ===== MON =====
# 查看 MON 選舉狀態
ceph mon stat
# e3: 3 mons: a,b,c  quorum 0,1,2 (a,b,c)  leader: a

# 查看 MON 的詳細 map
ceph mon dump

# ===== OSD =====
# 查看 OSD 樹狀結構（顯示 Node / Rack 層級）
ceph osd tree
# -1  root default
# -3  host node1
#  0  hdd 1.0 TiB  osd.0 up   in
#  1  hdd 1.0 TiB  osd.1 up   in

# 查看 OSD 效能（延遲）
ceph osd perf

# 查看某個 OSD 負責哪些 PG
ceph pg ls-by-osd 0

# 查看某個 PG 的詳細狀態
ceph pg 1.0 query

# 手動測試 OSD 故障回復
# （先把 OSD 0 標記為 out，觀察 recovery）
# ceph osd out 0
# watch ceph status  ← 看 recovery 進度
# ceph osd in 0     ← 恢復

# ===== MGR =====
ceph mgr stat
ceph mgr module ls | grep -E "enabled|disabled"

# 查看 Prometheus metrics endpoint
ceph mgr services
# {
#     "dashboard": "https://...",
#     "prometheus": "http://..."
# }

# ===== Pool 概覽 =====
ceph osd pool ls detail
# pool 1 '.mgr' replicated size 3 ...
# pool 2 'replicapool' replicated size 3 ...

# 查看每個 Pool 的容量使用
ceph df detail
```

### 用 Rook Dashboard 觀察

```bash
# Port-forward Dashboard
kubectl -n rook-ceph port-forward svc/rook-ceph-mgr-dashboard 7000:7000 &

# 取得密碼
kubectl -n rook-ceph get secret rook-ceph-dashboard-password \
  -o jsonpath='{.data.password}' | base64 -d && echo

# 開啟 http://localhost:7000
# 可以看到：
# - Cluster Health
# - OSD 列表和狀態
# - Pool 使用率
# - PG 分佈圖
```
