# 第五章：Networking

## 架構概覽

KubeVirt VM 的網路底層還是 k8s Pod 網路，但透過不同的 **binding** 方式決定 VM 怎麼接入網路。

```
VM（Guest OS）
    │
    │ 虛擬網卡（virtio / e1000 / rtl8139）
    ▼
virt-launcher Pod
    │
    ├── Pod Network（eth0）→ k8s CNI → 其他 Pod / Service
    │
    └── Secondary Network（透過 Multus）
             │
             ├── SR-IOV（直通硬體網卡，高效能）
             ├── Bridge（L2 橋接，直連實體網路）
             └── macvlan / ipvlan
```

---

## Interface Binding 類型

### 1. masquerade（最常用）

NAT 模式。VM 流量出去時 SNAT 成 Pod IP，類似家用路由器的 NAT。

```yaml
spec:
  domain:
    devices:
      interfaces:
        - name: default
          masquerade: {}      # 使用 NAT
          model: virtio
          ports:              # 選填：只開放這些 port 的流量進來
            - name: http
              port: 80
            - name: ssh
              port: 22
  networks:
    - name: default
      pod: {}
```

**特性：**
- VM 可以主動連外，外部要連進來需要透過 k8s Service
- 支援 IPv4/IPv6 dual-stack
- 相容 Service Mesh（Istio 等）
- **推薦用於大多數場景**

### 2. bridge（L2 直連）

透過 Linux bridge 讓 VM 直接接在 Pod 網路上，VM 擁有 Pod IP（透過 DHCP 獲得）。

```yaml
interfaces:
  - name: default
    bridge: {}
    model: virtio
```

!!! warning "bridge 模式的限制"
    - 和 Service Mesh（Istio、Linkerd）不相容
    - 在某些 CNI（如 Calico）上需要特殊設定
    - 不支援 Live Migration（預設）

### 3. SR-IOV（高效能直通）

把實體網卡的 Virtual Function（VF）直接 passthrough 給 VM，繞過所有軟體層：

```yaml
interfaces:
  - name: sriov-net
    sriov: {}
    model: virtio
networks:
  - name: sriov-net
    multus:
      networkName: sriov-network-attachment    # 對應 NetworkAttachmentDefinition
```

**特性：**
- 極高效能（接近裸機網路）
- 延遲最低
- 需要硬體支援（網卡要支援 SR-IOV）
- **支援 Live Migration**（v1.8+ 自動 hot-unplug 再 hot-plug）

### 4. passt（新一代 user-space 網路）

Passt 是一個 user-space 的網路代理，不需要 root 權限：

```yaml
interfaces:
  - name: default
    passt: {}
    ports:
      - port: 80
      - port: 22
```

**特性（v1.8+ 為 beta）：**
- 不需要 `CAP_NET_RAW` / `CAP_NET_ADMIN`
- 支援 Service Mesh
- 原生 IPv6 支援
- 額外記憶體消耗約 250Mi

---

## Multus：多重網路介面

Multus 讓 Pod（和 VM）能有多個網路介面。KubeVirt VM 常見需求：一個 Pod Network + 一個或多個特殊網路。

### 安裝 Multus

```bash
kubectl apply -f https://raw.githubusercontent.com/k8snetworkplumbingwg/multus-cni/master/deployments/multus-daemonset.yml
```

### 定義 NetworkAttachmentDefinition

```yaml
# 定義一個 Bridge 類型的 secondary network
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: flat-network
  namespace: default
spec:
  config: |
    {
      "cniVersion": "0.3.1",
      "name": "flat-network",
      "type": "bridge",
      "bridge": "br1",
      "isGateway": false,
      "ipam": {
        "type": "dhcp"
      }
    }
```

### VM 使用 Multus 網路

```yaml
spec:
  domain:
    devices:
      interfaces:
        - name: default
          masquerade: {}          # 第一個介面：Pod Network（NAT）
          model: virtio
        - name: flat-net
          bridge: {}              # 第二個介面：Multus Bridge
          model: virtio
          macAddress: "02:00:00:00:00:01"   # 固定 MAC（選填）
  networks:
    - name: default
      pod: {}
    - name: flat-net
      multus:
        networkName: flat-network    # 對應上面的 NetworkAttachmentDefinition
```

---

## 讓外部連進 VM

### 方法一：k8s Service（推薦）

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-vm-service
spec:
  selector:
    kubevirt.io/vm: my-vm       # 對應 VMI 的 label
  type: ClusterIP               # 或 LoadBalancer 對外
  ports:
    - name: ssh
      port: 22
      targetPort: 22
    - name: http
      port: 80
      targetPort: 8080
```

```bash
# SSH 到 VM
ssh user@$(kubectl get svc my-vm-service -o jsonpath='{.spec.clusterIP}')

# 用 virtctl 透過 API Server 建立 SSH tunnel（不需要 Service）
virtctl ssh --local-ssh user@my-vm
```

### 方法二：virtctl port-forward

臨時 port-forward，適合 debug：

```bash
# 把 VM 的 22 port 轉到本機 2222
virtctl port-forward my-vm 2222:22 &
ssh -p 2222 user@localhost
```

---

## 網路效能調優

### 多佇列（Multiqueue）

```yaml
devices:
  interfaces:
    - name: default
      masquerade: {}
  networkInterfaceMultiqueue: true    # 啟用多佇列
```

搭配多 vCPU 使用，讓每個 CPU core 有自己的 TX/RX queue，提升吞吐量。

!!! warning "Multiqueue 增加記憶體使用"
    每個 queue 需要額外的記憶體，且增加 MSI vector 消耗。若 VM 的 vCPU 很多，要注意 Host 的 MSI 限制。

### virtio-net 調優

```yaml
devices:
  interfaces:
    - name: default
      masquerade: {}
      model: virtio    # 確保用 virtio 而非 e1000
```

---

## 常見陷阱

!!! warning "masquerade 模式 VM 的 IP"
    VM 的 Guest OS 看到的 IP（masquerade 模式下通常是 10.0.2.2/24），和 Pod IP 不同。外部存取要透過 Service 的 ClusterIP，不能直接用 VM 看到的 IP 在 cluster 外存取。

!!! warning "bridge 模式和 IP 衝突"
    bridge 模式下 Pod IP 會被「借」給 VM（透過 DHCP），這表示 Pod 本身不直接持有那個 IP。某些 CNI 可能對此有相容性問題，需要測試確認。

!!! info "SR-IOV 和 Live Migration"
    SR-IOV 在傳統認知中不支援 Live Migration（因為是硬體直通）。但 KubeVirt v1.8+ 實作了自動 hot-unplug SR-IOV 介面，Migration 時暫時切回軟體網路，Migration 完成後再 hot-plug 回來。
