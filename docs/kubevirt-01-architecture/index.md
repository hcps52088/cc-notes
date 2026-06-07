# 第一章：KubeVirt 架構原理

## 核心設計思路

KubeVirt 不重造輪子，它建立在 k8s 之上，把所有調度、網路、儲存都委託給 k8s 處理，自己只負責「讓 VM 跑起來」這一件事。

```
┌─────────────────────────────────────────────────────────┐
│                    使用者 / kubectl / virtctl            │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                    Kubernetes API Server                  │
│              （VM 也是 CRD，走標準 k8s API）              │
└─────────────────────────────────────────────────────────┘
           │                              │
           ▼                              ▼
┌──────────────────┐           ┌──────────────────────┐
│   virt-api       │           │   virt-controller     │
│  （Webhook 驗證） │           │  （VM 生命週期管理）   │
└──────────────────┘           └──────────────────────┘
                                          │
                               建立 virt-launcher Pod
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────┐
│                      Worker Node                         │
│                                                          │
│  ┌─────────────┐    ┌──────────────────────────────┐   │
│  │ virt-handler│    │     virt-launcher Pod          │   │
│  │  （DaemonSet）│ ──▶│  libvirtd + QEMU/KVM process│   │
│  └─────────────┘    │  （每個 VM 一個獨立 Pod）      │   │
│                      └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## 核心元件詳解

### virt-api

- **角色**：API Server 的延伸，處理 KubeVirt 自定義資源的 Webhook
- **職責**：
    - Validating Webhook：驗證 VM/VMI 的 YAML 格式是否正確
    - Mutating Webhook：補全預設值（如 domain 設定）
    - 提供 subresource API（console、VNC、migrate 等）
- **無狀態**，可水平擴展

### virt-controller

- **角色**：類似 k8s 的 Controller Manager，管理 VM 的 Reconciliation Loop
- **職責**：
    - Watch VMI 狀態，決定何時建立 / 刪除 `virt-launcher` Pod
    - 處理 VM 的 start / stop / restart 邏輯
    - 管理 VMI 的 Phase 轉換（Pending → Scheduling → Running → Succeeded）
- **只有一個 active 實例**（leader election 機制）

### virt-handler

- **角色**：跑在每個 Node 的 DaemonSet，類似 kubelet 的角色
- **職責**：
    - 監看 Node 上所有 VMI，確保 VM 狀態正確
    - 和同 Node 上的 `virt-launcher` 通訊（透過 Unix socket）
    - 負責 VM 的 Live Migration 傳輸
    - 同步 Node 上 VM 的 domain 狀態回 API Server

### virt-launcher

- **角色**：每個 VMI 對應一個 Pod，VM 實際跑在這個 Pod 裡
- **職責**：
    - 在 Pod 裡跑一個私有的 **libvirtd** instance
    - 透過 libvirt API 啟動和管理 **QEMU/KVM** process
    - 監控 VM 的健康狀態，回報給 virt-handler
- **1 VMI = 1 virt-launcher Pod**，隔離性好，VM 崩潰不影響其他 VM

### libvirt + QEMU/KVM

```
virt-launcher
    │
    │ libvirt API（Unix socket）
    ▼
libvirtd（虛擬化管理 daemon）
    │
    │ 建立並管理
    ▼
QEMU process
    │
    │ 透過 KVM kernel module
    ▼
Hardware Virtualization（Intel VT-x / AMD-V）
```

- **libvirt**：虛擬化管理的標準介面，支援 QEMU、KVM、Xen 等
- **QEMU**：硬體模擬器，模擬 CPU、記憶體、設備
- **KVM**：Linux kernel 的虛擬化模組，讓 QEMU 直接使用 CPU 的硬體虛擬化指令，大幅提升效能

---

## VM 的啟動流程

```
1. 使用者 kubectl apply -f vm.yaml
        ↓
2. API Server 儲存 VirtualMachine CR 到 etcd
        ↓
3. virt-controller watch 到 VM（spec.running: true）
   → 建立對應的 VirtualMachineInstance（VMI）CR
        ↓
4. virt-controller 建立 virt-launcher Pod
   → Pod 被 Scheduler 分配到 Node
        ↓
5. Node 上的 virt-handler 偵測到新的 VMI
   → 透過 Unix socket 通知 virt-launcher
        ↓
6. virt-launcher 啟動私有 libvirtd
   → libvirtd 建立 QEMU 進程
   → QEMU 透過 KVM 啟動 VM
        ↓
7. VMI Phase 更新為 Running ✅
```

---

## KubeVirt 自定義資源（CRD）

| CRD | 說明 | 類比 |
|-----|------|------|
| `VirtualMachine` (VM) | 帶有生命週期管理的 VM，可 start/stop | Deployment |
| `VirtualMachineInstance` (VMI) | 實際跑著的 VM 實例，是暫時性的 | Pod |
| `VirtualMachineInstanceReplicaSet` | 管理多個相同 VMI | ReplicaSet |
| `VirtualMachineInstanceMigration` | 觸發 Live Migration | - |
| `VirtualMachineInstancetype` | 可重用的資源規格模板 | - |
| `VirtualMachinePreference` | 可重用的設備偏好設定 | - |
| `DataVolume` | 自動 import disk image 到 PVC | - |
| `KubeVirt` | KubeVirt Operator 的設定 CR | - |

---

## The KubeVirt Razor 原則

> 如果一個功能對 Pod 有益，就應該同時對 VM 有益，而不是只為 VM 單獨實作。

這個設計原則確保 KubeVirt 和 k8s 生態完全整合：
- **調度**：直接用 k8s Scheduler，VM 支援 affinity、taint/toleration、resource limits
- **網路**：直接用 CNI，VM 的網路和 Pod 一樣由 k8s 管理
- **儲存**：直接用 PVC / CSI，VM 的磁碟就是 PVC
- **監控**：Prometheus metrics 直接抓，和 container 工作負載統一觀測

---

## 常見陷阱

!!! warning "需要硬體虛擬化支援"
    KubeVirt 預設需要 Node 支援 Intel VT-x 或 AMD-V。若 Node 不支援（如 VM 上面跑 k8s），需要開啟 software emulation（效能較差）。
    ```bash
    # 確認 Node 是否支援硬體虛擬化
    kubectl get nodes -o jsonpath='{.items[*].status.allocatable}' | grep -i kvm
    # 或在 Node 上直接檢查
    egrep -c '(vmx|svm)' /proc/cpuinfo
    ```

!!! warning "virt-launcher Pod ≠ 普通 Pod"
    virt-launcher Pod 需要特殊權限（`CAP_NET_ADMIN`、存取 `/dev/kvm`），PSA 設為 `restricted` 的 Namespace 會導致 VM 無法啟動。

!!! info "VM vs VMI"
    - `VM` 是你想要的終態宣告（類似 Deployment）
    - `VMI` 是實際跑著的實例（類似 Pod）
    - 刪除 VMI 後，若 VM 的 `runStrategy` 是 `Always`，virt-controller 會自動重建 VMI
