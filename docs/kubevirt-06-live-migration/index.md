# 第六章：Live Migration

## 什麼是 Live Migration

Live Migration 讓正在執行的 VM 在**不停機**的情況下，從一個 Node 搬到另一個 Node。對 Guest OS 和連進去的使用者來說，幾乎感覺不到任何中斷。

**典型使用場景：**
- Node 要做維護（`kubectl drain`）
- 負載重新平衡
- 升級 Hypervisor（Host OS / QEMU 版本）

```
來源 Node                    目標 Node
┌─────────────────┐         ┌─────────────────┐
│ virt-launcher   │         │ virt-launcher   │
│ (VM 在跑)       │ ──記憶體傳輸──▶ (VM 準備接管)  │
│                 │         │                 │
└─────────────────┘         └─────────────────┘
        │                           │
        └─── 傳輸完成 → 切換 ────────┘
             （毫秒級切換）
```

---

## 前提條件

| 條件 | 說明 |
|------|------|
| PVC AccessMode | 必須是 `ReadWriteMany`（RWX），讓兩個 Node 同時存取 |
| 網路介面 | 不能用 bridge 模式的 Pod Network（masquerade 或 SR-IOV 可以） |
| Port 開放 | virt-launcher Pod 需要開放 49152 和 49153 port |
| 可遷移的 Node | cluster 至少要有 2 個可調度的 Node |
| Feature Gate | KubeVirt v0.56+ / v1.x 已**預設啟用** `LiveMigration`，舊版才需要手動開啟 |

```bash
# 確認 feature gate 狀態（v1.x 預設已啟用，無需額外設定）
kubectl get kubevirt kubevirt -n kubevirt -o jsonpath='{.spec.configuration.developerConfiguration.featureGates}'
```

---

## 三種遷移策略

### 策略比較

| | Pre-copy（預設） | Post-copy | Auto-converge |
|--|----------------|-----------|---------------|
| **切換時機** | 記憶體全數同步後切換 | 立刻切換，按需拉資料 | 跟 Pre-copy 相同 |
| **切換時間** | 可能較長（等同步完） | 極短（立刻切換） | 可能較長 |
| **風險** | 低，失敗可繼續在來源跑 | 高，目標故障會 VM crash | 中，CPU 被限速 |
| **高 dirty rate** | 可能無法收斂 | 不受影響 | 自動降 CPU 速讓收斂 |
| **VM 效能影響** | 輕微（記憶體複製消耗網路） | 存取缺頁有延遲 | 明顯（CPU 被限速） |
| **適用場景** | 大多數場景（推薦） | 切換時間嚴格要求 | 記憶體密集型工作負載 |
| **設定方式** | 預設 | `allowPostCopy: true` | `allowAutoConverge: true` |

### Pre-copy（預設，推薦）

```
1. 目標 Node 啟動新的 virt-launcher
2. 來源 Node 持續把記憶體 dirty page 傳給目標
3. 記憶體同步完畢後，VM 在來源暫停（毫秒級）
4. 剩餘 dirty page 傳輸完成
5. VM 在目標恢復執行
6. 來源的 virt-launcher 關閉
```

- **優點**：安全、快速，失敗可以直接在來源繼續
- **缺點**：若 VM 記憶體寫入速度很高（高 dirty rate），可能遲遲無法收斂
- **適用**：大多數情況

### Post-copy

```
1. 目標 Node 啟動 VM（立刻切換執行）
2. VM 在目標執行，所需頁面「按需」從來源傳輸
3. 後台持續把所有記憶體搬完
```

- **優點**：切換速度快，不需等記憶體同步完
- **缺點**：若目標 Node 故障，VM 資料可能損失；風險較高
- **適用**：有嚴格切換時間限制的場景

### Auto-converge

```
Migration 過程中若偵測到高 dirty rate，自動降低 VM 的 CPU 使用率
→ 減少記憶體寫入速度 → 加速收斂
```

- **優點**：解決高 dirty rate 導致遷移無法完成的問題
- **缺點**：會影響 VM 的效能（CPU 被限速）
- **適用**：記憶體密集型工作負載

---

## 設定 Live Migration 參數

在 KubeVirt CR 設定全域預設值：

```yaml
apiVersion: kubevirt.io/v1
kind: KubeVirt
metadata:
  name: kubevirt
  namespace: kubevirt
spec:
  configuration:
    migrations:
      # 整個 cluster 同時最多進行幾個 Migration
      parallelMigrationsPerCluster: 5

      # 每個 Node 同時最多幾個 outbound Migration
      parallelOutboundMigrationsPerNode: 2

      # 每個 Migration 的頻寬上限（0 = 無限制）
      bandwidthPerMigration: "64Mi"

      # 每 GiB 記憶體的最長遷移時間（秒）
      completionTimeoutPerGiB: 800

      # 多久沒有進度就放棄（秒）
      progressTimeout: 150

      # 是否允許 Post-copy
      allowPostCopy: false

      # 是否啟用 Auto-converge
      allowAutoConverge: false

      # 是否關閉 TLS 加密（不建議在生產環境）
      disableTLS: false

      # 來源和目標的主網路介面必須同名
      # （預設 pod network 介面名稱）
      network: ""
```

---

## 觸發 Live Migration

### 方法一：kubectl

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachineInstanceMigration
metadata:
  name: my-migration
  namespace: default
spec:
  vmiName: my-vmi      # 要遷移的 VMI 名稱
```

```bash
kubectl apply -f migration.yaml

# 查看遷移狀態
kubectl get vmim my-migration
kubectl describe vmim my-migration
```

### 方法二：virtctl

```bash
virtctl migrate my-vmi

# 取消遷移
virtctl migrate-cancel my-vmi
```

### 方法三：Node Drain（自動觸發）

```bash
# drain Node 時，KubeVirt 會自動把 VM live migrate 到其他 Node
kubectl drain my-node --delete-emptydir-data --ignore-daemonsets

# 確認所有 VM 都遷移完了再 drain
kubectl get vmi --all-namespaces -o wide | grep my-node
```

---

## Migration Policy（細粒度控制）

MigrationPolicy 讓你針對特定 VM 群組套用不同的遷移設定：

```yaml
apiVersion: migrations.kubevirt.io/v1alpha1
kind: MigrationPolicy
metadata:
  name: high-performance-vms
spec:
  selectors:
    virtualMachineInstanceSelector:
      matchLabels:
        workload-type: high-performance    # 只套用到有這個 label 的 VMI

    # 也可以套用到特定 namespace
    namespaceSelector:
      matchLabels:
        env: production

  # 覆蓋全域設定
  allowAutoConverge: true          # 高效能 VM 允許 Auto-converge
  bandwidthPerMigration: "256Mi"   # 給更多頻寬
  completionTimeoutPerGiB: 400     # 縮短超時時間
  allowPostCopy: false
```

---

## 觸發方式比較

| 觸發方式 | 適用場景 | 指定目標 Node | 批次處理 |
|---------|---------|-------------|---------|
| `VirtualMachineInstanceMigration` CR | 精確控制單個 VM | ❌（由 Scheduler 決定） | ❌ |
| `virtctl migrate <vmi>` | 快速手動觸發 | ❌ | ❌ |
| `kubectl drain <node>` | Node 維護，全部搬走 | ❌ | ✅（Node 上全部 VM） |
| `MigrationPolicy` | 自動化規則 | ❌ | ✅（符合 label 的） |

## 監控 Migration 狀態

```bash
# 查看所有進行中的 Migration
kubectl get vmim --all-namespaces

# 詳細狀態（包含記憶體傳輸進度）
kubectl describe vmim my-migration

# 從 VMI 狀態查看
kubectl get vmi my-vmi -o jsonpath='{.status.migrationState}'

# 查看相關 Events
kubectl get events --field-selector reason=Migrating
```

VMI migration state 欄位：

```json
{
  "migrationState": {
    "startTimestamp": "2026-01-01T00:00:00Z",
    "endTimestamp": "2026-01-01T00:01:00Z",
    "sourceNode": "node-1",
    "targetNode": "node-2",
    "targetPod": "virt-launcher-my-vmi-xxx",
    "completed": true,
    "failed": false,
    "migrationUid": "abc-123"
  }
}
```

---

## 常見陷阱

!!! warning "PVC 用 ReadWriteOnce 導致 Migration 失敗"
    這是最常見的問題。RWO 的 PVC 同一時間只能被一個 Node 掛載。Migration 時需要來源和目標同時存取，所以必須用 RWX。若 StorageClass 不支援 RWX，需要更換（如 Ceph RBD → CephFS，或用 NFS）。

!!! warning "高 dirty rate VM 遷移永遠無法收斂"
    記憶體寫入速度超過網路頻寬時，migration 永遠追不上。解法：
    1. 增加 `bandwidthPerMigration` 頻寬上限
    2. 開啟 `allowAutoConverge: true` 自動限速 VM CPU
    3. 選擇業務低峰期執行

!!! info "Migration 不影響 Service 連線"
    masquerade 模式的 VM 透過 k8s Service 存取，Migration 時 kube-proxy 規則更新指向新的 virt-launcher Pod，TCP 連線可能有短暫中斷（毫秒級），但新連線立刻可以建立。

---

## 隨堂測驗 {#quiz}

::: details 測驗 1：Pre-copy 和 Post-copy 的主要風險分別是什麼？
**答案：**

**Pre-copy 的風險**：
- 高 dirty rate（記憶體寫入速度 > 網路頻寬）時，migration 永遠追不上，無法完成
- 解法：開啟 `allowAutoConverge`（自動限速 VM CPU 降低 dirty rate）

**Post-copy 的風險**：
- VM 在目標 Node 開始執行後，所需的記憶體頁面還在來源 Node
- 若目標 Node **在傳輸過程中故障**，VM 資料直接丟失（不可逆）
- 若來源 Node 故障，VM 拿不到需要的頁面，直接 crash

**結論**：Pre-copy 失敗後 VM 還能在來源繼續跑（安全回退），Post-copy 一旦切換就沒有退路。預設應該用 Pre-copy，只在有嚴格切換時間要求時才考慮 Post-copy。
:::

::: details 測驗 2：為什麼 Live Migration 需要 RWX 的 PVC？RWO 為什麼不行？
**答案：**

Live Migration 的過程中，**來源 Node 和目標 Node 需要同時存取 VM 的磁碟**：

```
Pre-copy 最後階段：
  來源 Node（VM 還在跑） ──讀寫 PVC──▶ Ceph RBD
  目標 Node（接管準備中） ──讀寫 PVC──▶ Ceph RBD
  （同時存取！）
```

`ReadWriteOnce`（RWO）的語意是：**同一時間只能有一個 Node mount**。如果目標 Node mount PVC 時，來源 Node 還持有 mount，就會衝突失敗（或 CSI 強制解除來源 Node 的 mount，VM 直接崩潰）。

`ReadWriteMany`（RWX）允許多個 Node 同時 mount，所以可以。Ceph RBD 支援 RWX 需要 `mounter: rbd-nbd` 參數。
:::

::: details 測驗 3：`kubectl drain` 和手動觸發 VirtualMachineInstanceMigration 有什麼差別？
**答案：**

| | kubectl drain | 手動 VirtualMachineInstanceMigration |
|--|--------------|----------------------------------|
| 觸發對象 | Node 上**所有** VM 和 Pod | **指定一個** VMI |
| 目標 Node | 由 Scheduler 決定 | 由 Scheduler 決定（無法指定） |
| 使用場景 | Node 維護（全部搬走） | 手動平衡負載、測試遷移 |
| Pod 的處理 | 正常 Pod 直接刪除重建 | 不影響其他 Pod |

`kubectl drain` 時，KubeVirt 攔截 VM 相關 Pod 的驅逐請求，改成 Live Migration（不是直接刪 Pod），確保 VM 不停機。這需要 `KubevirtEvictionPolicy` 設定正確。
:::

---

## 實作：完整 Live Migration 流程

```bash
# === 準備：確認 RWX StorageClass 存在 ===
kubectl get sc | grep rwx
# 若沒有，先建立（參考 Rook 章節）

# === 建立支援 Live Migration 的 VM ===
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: vm-migration-disk
spec:
  storageClassName: rook-ceph-block-rwx   # RWX StorageClass
  accessModes: [ReadWriteMany]
  volumeMode: Block
  resources:
    requests:
      storage: 5Gi
---
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: migratable-vm
spec:
  runStrategy: RerunOnFailure
  template:
    spec:
      domain:
        cpu:
          cores: 1
        memory:
          guest: 512Mi
        devices:
          disks:
            - name: disk
              disk:
                bus: virtio
          interfaces:
            - name: default
              masquerade: {}
      networks:
        - name: default
          pod: {}
      volumes:
        - name: disk
          persistentVolumeClaim:
            claimName: vm-migration-disk
EOF

# === 啟動 VM ===
virtctl start migratable-vm
kubectl get vmi migratable-vm -w   # 等待 Running

# === 查看 VM 在哪個 Node ===
kubectl get vmi migratable-vm -o jsonpath='{.status.nodeName}'

# === 觸發 Live Migration ===
kubectl apply -f - <<'EOF'
apiVersion: kubevirt.io/v1
kind: VirtualMachineInstanceMigration
metadata:
  name: test-migration
spec:
  vmiName: migratable-vm
EOF

# === 監控 Migration 進度 ===
kubectl get vmim test-migration -w
# 或
kubectl describe vmim test-migration

# === 確認 VM 搬到不同 Node ===
kubectl get vmi migratable-vm -o jsonpath='{.status.nodeName}'
# 應該和之前的 Node 不同

# === 用 virtctl 觸發（更簡單）===
virtctl migrate migratable-vm

# 取消 Migration
virtctl migrate-cancel migratable-vm

# === 模擬 Node 維護 ===
NODE=$(kubectl get vmi migratable-vm -o jsonpath='{.status.nodeName}')
kubectl cordon $NODE   # 標記 Node 不再接收新 Pod
# KubeVirt 會自動把這個 Node 上的 VM Live Migrate 走

# 完成維護後
kubectl uncordon $NODE

# === 清理 ===
kubectl delete vm migratable-vm
kubectl delete pvc vm-migration-disk
kubectl delete vmim test-migration 2>/dev/null || true
```
