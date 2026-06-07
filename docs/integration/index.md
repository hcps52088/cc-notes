# 整合架構：K8s + Rook/Ceph + KubeVirt

## 架構全景

```
┌──────────────────────────────────────────────────────────────────┐
│                      Kubernetes Cluster                           │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                 Control Plane                                │ │
│  │   API Server  │  etcd  │  Scheduler  │  Controller Manager  │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                              │                                    │
│  ┌───────────────────────────▼──────────────────────────────┐    │
│  │                      Worker Nodes                         │    │
│  │                                                           │    │
│  │  ┌──────────────────┐      ┌───────────────────────────┐ │    │
│  │  │  KubeVirt Stack  │      │     Rook / Ceph Stack     │ │    │
│  │  │                  │      │                           │ │    │
│  │  │  virt-handler    │      │  rook-operator            │ │    │
│  │  │  virt-launcher   │      │  ceph-mon × 3             │ │    │
│  │  │  ┌────────────┐  │      │  ceph-mgr × 2             │ │    │
│  │  │  │ QEMU/KVM   │  │      │  ceph-osd × N             │ │    │
│  │  │  │ (VM)       │  │      │  csi-rbdplugin            │ │    │
│  │  │  └─────┬──────┘  │      └────────────┬──────────────┘ │    │
│  │  └────────│──────────┘                  │                 │    │
│  │           │ PVC（RBD）                   │ StorageClass    │    │
│  │           └─────────────────────────────┘                 │    │
│  │                                                           │    │
│  │   Raw Disk: /dev/sdb /dev/sdc ...（給 Ceph OSD 用）       │    │
│  └───────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

## 資料流

```
使用者 kubectl apply VM
         │
         ▼
API Server → virt-controller 建立 VMI
         │
         ▼
virt-controller 建立 virt-launcher Pod
         │
         ▼
Pod 需要 PVC（VM 磁碟）
         │
         ▼
Rook CSI Driver 向 Ceph 申請 RBD Image
         │
         ▼
Ceph 在多個 OSD 上分散儲存
（自動 3 副本，分散在不同 Node）
         │
         ▼
RBD Image map 到 Node，掛載給 virt-launcher
         │
         ▼
QEMU/KVM 使用這個 block device 啟動 VM ✅
```

---

## 為什麼這個組合有意義？

### 問題背景

傳統上，要同時管理**容器**和**虛擬機**，需要兩套系統：
- vSphere / KVM 管 VM
- Kubernetes 管容器
- 各自的網路、儲存、監控

這帶來巨大的運維成本：兩套工具、兩套技能、兩套 YAML。

### 這個架構的價值

```
統一用 Kubernetes API 管一切：

kubectl get vm            # 看 VM
kubectl get pod           # 看容器
kubectl get pvc           # 看儲存（VM 磁碟 = PVC）
kubectl get svc           # 看網路（VM 和容器共用）
```

| 功能 | 實作 |
|------|------|
| **VM 調度** | k8s Scheduler（和 Pod 一樣） |
| **VM 磁碟** | Ceph RBD（透過 Rook CSI） |
| **VM 網路** | k8s CNI + Multus |
| **VM 監控** | Prometheus + Grafana（同一套） |
| **VM 備份** | VolumeSnapshot（Ceph 快照） |
| **VM 遷移** | KubeVirt Live Migration（需要 RWX PVC） |
| **儲存擴展** | `kubectl edit pvc`（Ceph 線上 resize） |

---

## Live Migration 的儲存需求

Live Migration 需要來源和目標 Node 同時存取 VM 磁碟，這要求 PVC 是 **ReadWriteMany（RWX）**。

Ceph RBD 支援 RWX 需要特殊設定：

```yaml
# 方案一：用支援 RWX 的 RBD StorageClass
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-ceph-block-rwx
provisioner: rook-ceph.rbd.csi.ceph.com
parameters:
  clusterID: rook-ceph
  pool: replicapool
  # 啟用 RWX 需要：
  mounter: rbd-nbd                # 或用 krbd（kernel RBD）
reclaimPolicy: Delete
allowVolumeExpansion: true

---
# 方案二：改用 CephFS（天生支援 RWX）
# 但 CephFS 給 VM 磁碟效能不如 RBD
```

```yaml
# VM 的 PVC 要明確宣告 RWX
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: vm-disk-rwx
spec:
  storageClassName: rook-ceph-block-rwx
  accessModes:
    - ReadWriteMany              # Live Migration 必要
  volumeMode: Block
  resources:
    requests:
      storage: 50Gi
```

---

## 整合部署順序

```
1. 安裝 k8s cluster
        ↓
2. 安裝 CNI（Calico / Cilium）
        ↓
3. 安裝 Rook Operator
        ↓
4. 建立 CephCluster（等 HEALTH_OK）
        ↓
5. 建立 CephBlockPool + StorageClass
        ↓
6. 安裝 KubeVirt Operator
        ↓
7. 建立 KubeVirt CR（等 Available）
        ↓
8. 安裝 CDI（Containerized Data Importer）
        ↓
9. 建立 VM（DataVolume 從 Ceph 申請 PVC，import OS image）
        ↓
VM 跑起來 ✅
```

---

## 端對端實作：從零到一個跑起來的 VM

```bash
# === 第一步：確認 Ceph 正常 ===
kubectl -n rook-ceph get cephcluster
# HEALTH_OK

# === 第二步：確認 StorageClass 存在 ===
kubectl get storageclass
# rook-ceph-block  rook-ceph.rbd.csi.ceph.com  Delete  Immediate  true

# === 第三步：確認 KubeVirt 正常 ===
kubectl -n kubevirt get kubevirt
# PHASE: Deployed

# === 第四步：建立 VM（用 DataVolume 從 URL import OS）===
kubectl apply -f - <<'EOF'
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: fedora-vm
spec:
  runStrategy: RerunOnFailure
  template:
    spec:
      domain:
        cpu:
          cores: 2
        memory:
          guest: 2Gi
        devices:
          disks:
            - name: rootdisk
              disk:
                bus: virtio
            - name: cloudinit
              disk:
                bus: virtio
          interfaces:
            - name: default
              masquerade: {}
      networks:
        - name: default
          pod: {}
      volumes:
        - name: rootdisk
          dataVolume:
            name: fedora-vm-disk
        - name: cloudinit
          cloudInitNoCloud:
            userData: |
              #cloud-config
              password: fedora123
              chpasswd: { expire: False }
  dataVolumeTemplates:
    - metadata:
        name: fedora-vm-disk
      spec:
        storage:
          storageClassName: rook-ceph-block   # 使用 Ceph RBD
          accessModes:
            - ReadWriteOnce
          volumeMode: Block
          resources:
            requests:
              storage: 10Gi
        source:
          registry:
            url: docker://quay.io/containerdisks/fedora:40
EOF

# === 第五步：等待 DataVolume import 完成 ===
kubectl get datavolume fedora-vm-disk -w
# PHASE 從 ImportScheduled → ImportInProgress → Succeeded

# === 第六步：等待 VM Running ===
kubectl get vmi fedora-vm -w
# PHASE → Running

# === 第七步：進入 VM ===
virtctl console fedora-vm
# 用 fedora / fedora123 登入

# === 確認 VM 磁碟來自 Ceph ===
kubectl get pvc fedora-vm-disk
# STORAGECLASS: rook-ceph-block ✅
```

---

## 監控整合

```bash
# Ceph 暴露 Prometheus metrics
kubectl -n rook-ceph get servicemonitor

# 常用監控指標
ceph_cluster_total_bytes          # Cluster 總容量
ceph_cluster_total_used_bytes     # 已使用容量
ceph_health_status                # Cluster 健康狀態（0=OK）
ceph_osd_up                       # OSD 在線數量
kubevirt_vmi_phase_count          # VM 各狀態數量
```

---

## 隨堂測驗 {#quiz}

::: details 測驗 1：為什麼 VM 的磁碟要用 Ceph RBD 而不是 hostPath？
**答案：** 三個主要原因：

1. **資料安全**：hostPath 資料在 Node 本地，Node 故障資料就消失。Ceph 自動保持 3 副本，分散在不同 Node。
2. **Live Migration**：VM 要在 Node 間遷移，磁碟必須兩個 Node 都能存取。hostPath 做不到。
3. **動態擴容**：Ceph 的 PVC 可以在線 resize（`kubectl edit pvc`），hostPath 不行。
:::

::: details 測驗 2：整合架構中，誰負責決定 VM 跑在哪個 Node？
**答案：** **Kubernetes Scheduler**

KubeVirt 不自己做 VM 調度，它把 virt-launcher 做成一個 Pod，讓 k8s Scheduler 決定這個 Pod（也就是 VM）跑在哪個 Node。

這樣 VM 就能享受所有 k8s 調度功能：affinity、anti-affinity、taint/toleration、resource limits、PodDisruptionBudget 等。
:::

::: details 測驗 3：VM 做 Live Migration 時，Ceph 扮演什麼角色？
**答案：** Ceph 提供 **ReadWriteMany 的 PVC**，讓來源 Node 和目標 Node 同時能讀寫 VM 磁碟。

Migration 流程：
1. 目標 Node 的 virt-launcher 啟動，從 Ceph 掛載 VM 磁碟（RWX PVC）
2. 記憶體內容從來源傳到目標（透過網路）
3. 切換執行，VM 在目標 Node 繼續跑
4. 來源 Node 的 virt-launcher 關閉，解除掛載

整個過程 Ceph 磁碟不需要遷移，資料本來就是分散式存放在多個 Node 上。
:::
