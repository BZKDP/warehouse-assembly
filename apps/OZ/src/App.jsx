import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import AdminEmployeeStatsModal from "./views/AdminEmployeeStatsModal.jsx";
import CollectorView from "./views/CollectorView.jsx";
import EmployeeView from "./views/EmployeeView.jsx";
import UserDirectoryPicker from "./components/UserDirectoryPicker.jsx";

const API_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;
const REFRESH_NEW_MS = 20000;
const REFRESH_ASSEMBLIES_MS = 15000;
const REFRESH_EMPLOYEE_MS = 7000;

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { cache: "no-store", credentials: "include", ...options });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const message =
      (data && typeof data === "object" && (data.error || data.message)) ||
      (typeof data === "string" ? data : null) ||
      `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data ?? {};
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("ru-RU");
}

function AdminProductPhoto({ src, alt = "Фото товара" }) {
  const image = String(src || "").trim();
  return (
    <button
      className={`admin-product-photo${image ? "" : " is-missing"}`}
      type="button"
      disabled={!image}
      onClick={() => image && window.open(image, "_blank", "noopener,noreferrer")}
      title={image ? "Открыть фото" : "Нет фото"}
    >
      {image ? <img src={image} alt={alt} loading="lazy" /> : <span>Нет фото</span>}
    </button>
  );
}

function timeAgo(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const diff = Math.max(0, Date.now() - date.getTime());
  const min = Math.floor(diff / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}ч ${m}м назад`;
}

const ACCESS_MODE_LABELS = {
  hidden: "Скрыта",
  selected_split: "Выбранным с разделением",
};

const ROLE_LABELS = {
  super_admin: "Супер админ",
  admin: "Админ",
  employee: "Сотрудник",
};

const EMPLOYEE_POSITION_PACKER = "packer";
const EMPLOYEE_POSITION_COLLECTOR = "collector";
const EMPLOYEE_POSITION_LABELS = {
  [EMPLOYEE_POSITION_PACKER]: "Упаковщик",
  [EMPLOYEE_POSITION_COLLECTOR]: "Сборщик",
};

function normalizeEmployeePosition(value) {
  return EMPLOYEE_POSITION_PACKER;
}

function employeePositionLabel(position) {
  return EMPLOYEE_POSITION_LABELS[normalizeEmployeePosition(position)] || EMPLOYEE_POSITION_LABELS[EMPLOYEE_POSITION_PACKER];
}

const LABEL_STATUS_LABELS = {
  idle: "Ожидают загрузки",
  pending: "Ожидают загрузки",
  loading: "Загрузка",
  partial: "Частично загружены",
  ready: "Загружены",
  done: "Загружены",
  error: "Ошибка",
};

function accessModeLabel(mode) {
  if (!mode) return "-";
  return ACCESS_MODE_LABELS[mode] || mode;
}

function roleLabel(role, position = null) {
  if (!role) return "-";
  if (role === "employee") {
    return `Сотрудник · ${employeePositionLabel(position)}`;
  }
  return ROLE_LABELS[role] || role;
}

function displayUserName(user) {
  return user?.fullName || `${user?.surname || ""} ${user?.name || ""}`.trim() || user?.login || "—";
}

function buildStoreHeaders(storeId) {
  return storeId ? { "X-Store-Id": storeId } : {};
}

function labelsStatusLabel(status) {
  if (!status) return "-";
  return LABEL_STATUS_LABELS[String(status).trim().toLowerCase()] || status;
}

function postingStatusLabel(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized) return "-";
  if (normalized === "awaiting_packaging") return "Ожидают сборки";
  if (normalized === "awaiting_deliver") return "Ожидают отгрузки";
  if (normalized === "delivered") return "Отгружены";
  if (normalized === "cancelled" || normalized === "canceling") return "Отменены";
  return status;
}

function normalizeFbsProgress(progress, fallbackRunning = false) {
  const stage = String(progress?.stage || "idle");
  const done = Number(progress?.done || 0);
  const total = Number(progress?.total || 0);
  const percentRaw = Number(progress?.percent);
  const percent = Number.isFinite(percentRaw)
    ? Math.max(0, Math.min(100, percentRaw))
    : total > 0
    ? Math.max(0, Math.min(100, (done / total) * 100))
    : 0;
  const runningFromStage = stage !== "idle" && stage !== "done" && stage !== "error";
  return {
    stage,
    message: String(progress?.message || ""),
    done,
    total,
    percent,
    current: progress?.current || null,
    running: Boolean(progress?.running) || (fallbackRunning && runningFromStage),
  };
}

function patchEmployeeAssemblyWorkflowState(assembly, sessionData, workflowData) {
  if (!assembly) return assembly;
  const nextCurrentStage = workflowData?.currentStage || assembly.currentStage || "";
  const nextCanWork =
    nextCurrentStage === "packing" ||
    Boolean(sessionData?.startedAt && !sessionData?.finishedAt);
  return {
    ...assembly,
    session: sessionData || assembly.session || null,
    workflowMode: workflowData?.workflowMode || assembly.workflowMode,
    workflowStage: workflowData?.workflowStage || assembly.workflowStage,
    currentStage: nextCurrentStage || assembly.currentStage,
    productPickingRequired:
      workflowData?.productPickingRequired ?? assembly.productPickingRequired,
    productPickingActive:
      workflowData?.productPickingActive ?? assembly.productPickingActive,
    canStart: Boolean(workflowData?.canStartPicking || workflowData?.canStartPacking),
    canStartPicking: Boolean(workflowData?.canStartPicking),
    canFinishPicking: Boolean(workflowData?.canFinishPicking),
    canStartPacking: Boolean(workflowData?.canStartPacking),
    canWork: nextCanWork,
    isWaitingAdmin: Boolean(workflowData?.isWaitingAdmin),
  };
}

function normalizePickCellName(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/C/g, "С")
    .replace(/P/g, "П");
}

function parsePickCellSortValue(value) {
  const normalized = normalizePickCellName(value);
  if (!normalized) {
    return {
      known: false,
      rack: Number.MAX_SAFE_INTEGER,
      shelf: Number.MAX_SAFE_INTEGER,
      tail: "",
      raw: "",
    };
  }
  const match = normalized.match(/^С(\d+)П(\d+)(.*)$/u);
  if (match) {
    return {
      known: true,
      rack: Number(match[1]),
      shelf: Number(match[2]),
      tail: match[3] || "",
      raw: normalized,
    };
  }
  return {
    known: false,
    rack: Number.MAX_SAFE_INTEGER,
    shelf: Number.MAX_SAFE_INTEGER,
    tail: "",
    raw: normalized,
  };
}

function comparePickCellNames(left, right) {
  const a = parsePickCellSortValue(left);
  const b = parsePickCellSortValue(right);
  if (a.known !== b.known) return a.known ? -1 : 1;
  if (a.rack !== b.rack) return a.rack - b.rack;
  if (a.shelf !== b.shelf) return a.shelf - b.shelf;
  if (a.tail !== b.tail) {
    return a.tail.localeCompare(b.tail, "ru", { numeric: true, sensitivity: "base" });
  }
  return a.raw.localeCompare(b.raw, "ru", { numeric: true, sensitivity: "base" });
}

function sortPickCells(cells) {
  return [...(Array.isArray(cells) ? cells : [])].sort((left, right) =>
    comparePickCellNames(left?.name || left?.id || "", right?.name || right?.id || "")
  );
}

function getPickItemPrimaryCellName(item) {
  const firstCell = sortPickCells(item?.msCells || [])[0];
  return firstCell?.name || firstCell?.id || "";
}

function sortEmployeePickItems(items) {
  return [...(Array.isArray(items) ? items : [])]
    .filter((item) => Number(item?.remainingQty ?? 0) > 0)
    .sort((left, right) => {
      const byCell = comparePickCellNames(
        getPickItemPrimaryCellName(left),
        getPickItemPrimaryCellName(right)
      );
      if (byCell !== 0) return byCell;
      const byArticle = String(left?.article || "").localeCompare(String(right?.article || ""), "ru", {
        numeric: true,
        sensitivity: "base",
      });
      if (byArticle !== 0) return byArticle;
      const byName = String(left?.productName || "").localeCompare(String(right?.productName || ""), "ru", {
        numeric: true,
        sensitivity: "base",
      });
      if (byName !== 0) return byName;
      return Number(left?.id || 0) - Number(right?.id || 0);
    });
}

function hasNonEmptyPickCells(cells) {
  return Array.isArray(cells) && cells.some((cell) => String(cell?.name || cell?.id || "").trim());
}

function mergeEmployeePickItem(items, updatedItem) {
  if (!updatedItem?.id) return sortEmployeePickItems(items);
  if (Number(updatedItem?.remainingQty ?? 0) <= 0) {
    return sortEmployeePickItems(
      (Array.isArray(items) ? items : []).filter((item) => Number(item?.id) !== Number(updatedItem.id))
    );
  }
  let found = false;
  const next = (Array.isArray(items) ? items : []).map((item) => {
    if (Number(item?.id) !== Number(updatedItem.id)) return item;
    found = true;
    return {
      ...item,
      ...updatedItem,
      msCells: hasNonEmptyPickCells(updatedItem?.msCells) ? updatedItem.msCells : item?.msCells || [],
    };
  });
  if (!found) next.push(updatedItem);
  return sortEmployeePickItems(next);
}

function formatFbsCells(cells) {
  const list = sortPickCells(cells);
  if (!list.length) return "—";
  const multiple = list.length > 1;
  return list
    .map((cell) => {
      const name = String(cell?.name || cell?.id || "").trim() || "—";
      const stock = Number(cell?.stock ?? 0);
      return multiple ? `${name} (${stock})` : name;
    })
    .filter(Boolean)
    .join(", ");
}

function formatFbsValueList(values) {
  const source = Array.isArray(values) ? values : [values];
  const list = [];
  for (const value of source) {
    const text = String(value ?? "").trim();
    if (!text || list.includes(text)) continue;
    list.push(text);
  }
  return list.length ? list.join(", ") : "—";
}

function labelErrorText(message) {
  const text = String(message || "").trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  if (lower === "fetch failed") {
    return "Ошибка сети при загрузке этикеток. Нажмите «Обновить этикетки» и повторите.";
  }
  if (lower.includes("network") || lower.includes("fetch failed")) {
    return "Сетевая ошибка при загрузке этикеток. Нажмите «Обновить этикетки».";
  }
  return text;
}

function orderItemsSummary(order) {
  const items = Array.isArray(order?.products) ? order.products : Array.isArray(order?.items) ? order.items : [];
  if (!items.length) return "-";
  return items
    .map((item) => {
      const article = item.offerId || item.article || "-";
      const name = String(item.name || "").trim();
      const qty = Number(item.quantity || 0);
      return name ? `${article} (${name}) x${qty}` : `${article} x${qty}`;
    })
    .join(", ");
}

function sanitizeFilePart(value, fallback = "export") {
  const normalized = String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function formatOzonMarketplaceBarcode(sku) {
  const normalized = String(sku ?? "").trim();
  if (!normalized) return "";
  if (/^OZN/i.test(normalized)) return normalized;
  return /^\d+$/.test(normalized) ? `OZN${normalized}` : normalized;
}

function aggregateAssemblyItems(orders) {
  const map = new Map();
  for (const order of Array.isArray(orders) ? orders : []) {
    for (const item of Array.isArray(order?.items) ? order.items : []) {
      const article = String(item.article || "").trim() || "-";
      const name = String(item.name || "").trim() || "-";
      const sku = Number.isFinite(Number(item.sku)) ? Number(item.sku) : null;
      const key = `${article}::${name}::${sku ?? ""}`;
      if (!map.has(key)) {
        map.set(key, {
          article,
          name,
          sku,
          imageUrl: item.imageUrl || "",
          marketplaceBarcode: formatOzonMarketplaceBarcode(sku),
          count: 0,
        });
      }
      const entry = map.get(key);
      if (!entry.imageUrl && item.imageUrl) entry.imageUrl = item.imageUrl;
      entry.count += Math.max(0, Number(item.quantity || 0));
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

function sortOrders(orders, sortDir) {
  const out = [...orders].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  if (sortDir === "newest") out.reverse();
  return out;
}

function pickOrdersByCount(orders, sortDir, count) {
  const sorted = sortOrders(orders, sortDir);
  return sorted.slice(0, count);
}

function buildArticleSelection(rows, orders) {
  const byArticle = new Map();
  for (const order of orders) {
    const products = Array.isArray(order.products) ? order.products : [];
    for (const product of products) {
      const article = String(product.offerId || "").trim();
      if (!article) continue;
      if (!byArticle.has(article)) byArticle.set(article, []);
      byArticle.get(article).push({ order, qty: Number(product.quantity || 0) });
    }
  }

  const selectedMap = new Map();
  const availableByArticle = new Map();

  for (const [article, list] of byArticle.entries()) {
    const total = list.reduce((sum, item) => sum + Number(item.qty || 0), 0);
    availableByArticle.set(article, total);
  }

  for (const row of rows) {
    const article = String(row.article || "").trim();
    if (!article) continue;
    const requestedQty = Math.max(0, Number(row.count || 0));
    if (!requestedQty) continue;
    const source = byArticle.get(article) || [];
    const sorted = [...source].sort((a, b) => new Date(a.order.createdAt || 0) - new Date(b.order.createdAt || 0));
    if (row.sortDir === "newest") sorted.reverse();

    let covered = 0;
    for (const item of sorted) {
      if (covered >= requestedQty) break;
      covered += Math.max(0, Number(item.qty || 0));
      selectedMap.set(item.order.postingNumber, item.order);
    }
  }

  return {
    selected: Array.from(selectedMap.values()),
    availableByArticle,
  };
}

function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total - hours * 3600 - minutes * 60;
  const secsText = Number(secs.toFixed(2)).toString();
  if (hours > 0) return `${hours} ч ${minutes} мин ${secsText} сек`;
  if (minutes > 0) return `${minutes} мин ${secsText} сек`;
  return `${Number(total.toFixed(2)).toString()} сек`;
}

function shiftDateString(date, days) {
  if (!date) return "";
  const [year, month, day] = String(date).split("-").map(Number);
  if (!year || !month || !day) return "";
  const value = new Date(year, month - 1, day + days);
  const yyyy = value.getFullYear();
  const mm = String(value.getMonth() + 1).padStart(2, "0");
  const dd = String(value.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function resolveStatsRange(rangeKey, customFrom, customTo) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (rangeKey === "today") return { from: today, to: today };
  if (rangeKey === "7d") return { from: shiftDateString(today, -6), to: today };
  if (rangeKey === "30d") return { from: shiftDateString(today, -29), to: today };
  if (rangeKey === "month") {
    return {
      from: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`,
      to: today,
    };
  }
  if (rangeKey === "custom" && customFrom && customTo) return { from: customFrom, to: customTo };
  return { from: today, to: today };
}

function LoginView({ surname, setSurname, password, setPassword, error, busy, onLogin }) {
  return (
    <div className="app">
      <div className="login-card">
        <div className="login-title">Вход</div>
        <div className="login-subtitle">Ozon FBS · логин и пароль из общей базы сотрудников</div>
        <div className="form-grid">
          <label className="field">
            <span>Логин</span>
            <input className="input" value={surname} onChange={(e) => setSurname(e.target.value)} placeholder="Данила Пущин" />
          </label>
          <label className="field">
            <span>Пароль</span>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        </div>
        {error && <div className="alert">{error}</div>}
        <div className="login-actions">
          <button className="primary-button" type="button" onClick={onLogin} disabled={busy}>
            {busy ? "Вход..." : "Войти"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [storeOptions, setStoreOptions] = useState([]);
  const [storeId, setStoreId] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem("oz_store_id") || "";
  });

  const [loginSurname, setLoginSurname] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);

  const [userTab, setUserTab] = useState("admins");
  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState("");
  const [userDirectory, setUserDirectory] = useState([]);
  const [userDirectoryLoading, setUserDirectoryLoading] = useState(false);
  const [userDirectoryError, setUserDirectoryError] = useState("");
  const [createExternalUserId, setCreateExternalUserId] = useState("");
  const [userBusy, setUserBusy] = useState(false);
  const [userActionError, setUserActionError] = useState("");
  const [editUser, setEditUser] = useState(null);
  const [editRole, setEditRole] = useState("employee");

  const [tab, setTab] = useState("new");
  const [newOrders, setNewOrders] = useState([]);
  const [newError, setNewError] = useState("");
  const [newLoading, setNewLoading] = useState(false);
  const [newUpdatedAt, setNewUpdatedAt] = useState(null);

  const [assemblies, setAssemblies] = useState([]);
  const [assembliesLoading, setAssembliesLoading] = useState(false);
  const [assembliesError, setAssembliesError] = useState("");
  const [fbsStockItems, setFbsStockItems] = useState([]);
  const [fbsStockLoading, setFbsStockLoading] = useState(false);
  const [fbsStockError, setFbsStockError] = useState("");
  const [fbsStockWarehouseName, setFbsStockWarehouseName] = useState("Ижевск FBS");
  const [fbsStockTotals, setFbsStockTotals] = useState({ all: 0, ok: 0, shortage: 0, errors: 0 });
  const [fbsStockScopeStores, setFbsStockScopeStores] = useState([]);
  const [fbsStockUpdatedAt, setFbsStockUpdatedAt] = useState(null);
  const [fbsStockProgress, setFbsStockProgress] = useState({
    stage: "idle",
    message: "",
    done: 0,
    total: 0,
    percent: 0,
    current: null,
    running: false,
  });
  const [fbsStockRefreshing, setFbsStockRefreshing] = useState(false);
  const [stockProblems, setStockProblems] = useState({
    negativeShelves: [],
    negativeEmployees: [],
    leftoverEmployees: [],
  });
  const [stockProblemsLoading, setStockProblemsLoading] = useState(false);
  const [stockProblemsError, setStockProblemsError] = useState("");
  const [stockProblemsUpdatedAt, setStockProblemsUpdatedAt] = useState(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [syncInfo, setSyncInfo] = useState("");

  const [selectedAssembly, setSelectedAssembly] = useState(null);
  const [assemblyTab, setAssemblyTab] = useState("orders");
  const [assemblyOrders, setAssemblyOrders] = useState([]);
  const [assemblyOrdersLoading, setAssemblyOrdersLoading] = useState(false);
  const [assemblyOrdersError, setAssemblyOrdersError] = useState("");
  const [assemblySettings, setAssemblySettings] = useState(null);
  const [, setAssemblySettingsLoading] = useState(false);
  const [assemblySettingsError, setAssemblySettingsError] = useState("");
  const [assemblySettingsNotice, setAssemblySettingsNotice] = useState("");
  const [assemblyLabelDiagnostics, setAssemblyLabelDiagnostics] = useState(null);
  const [assemblyLabelDiagnosticsLoading, setAssemblyLabelDiagnosticsLoading] = useState(false);
  const [assemblyLabelDiagnosticsError, setAssemblyLabelDiagnosticsError] = useState("");
  const [accessMode, setAccessMode] = useState("hidden");
  const [accessUsers, setAccessUsers] = useState([]);
  const [assemblyAccessDirty, setAssemblyAccessDirty] = useState(false);
  const [assemblyEmployeeQuery, setAssemblyEmployeeQuery] = useState("");
  const [assemblyEmployees, setAssemblyEmployees] = useState([]);
  const [assemblyProgress, setAssemblyProgress] = useState([]);
  const [assemblyTotals, setAssemblyTotals] = useState({ total: 0, collected: 0, remaining: 0, readyToShip: 0 });
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [shipmentBusy, setShipmentBusy] = useState(false);
  const [shipmentError, setShipmentError] = useState("");
  const [shipmentNotice, setShipmentNotice] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState("count");
  const [createCount, setCreateCount] = useState(50);
  const [createSort, setCreateSort] = useState("newest");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const [articleRows, setArticleRows] = useState([{ id: 1, article: "", count: 1, sortDir: "newest" }]);
  const rowIdRef = useRef(2);

  const [employeeAssemblies, setEmployeeAssemblies] = useState([]);
  const [employeeAssembliesLoading, setEmployeeAssembliesLoading] = useState(false);
  const [employeeAssembliesError, setEmployeeAssembliesError] = useState("");
  const [employeeSelectedAssembly, setEmployeeSelectedAssembly] = useState(null);
  const [employeeAssemblySession, setEmployeeAssemblySession] = useState(null);
  const [employeeAssemblySessionLoading, setEmployeeAssemblySessionLoading] = useState(false);
  const [employeeAssemblySessionError, setEmployeeAssemblySessionError] = useState("");
  const [employeeStartBusy, setEmployeeStartBusy] = useState(false);
  const [employeeStartError, setEmployeeStartError] = useState("");
  const [employeeFlowNotice, setEmployeeFlowNotice] = useState("");
  const [employeeFlowWarning, setEmployeeFlowWarning] = useState("");
  const [employeePickItems, setEmployeePickItems] = useState([]);
  const [employeePickItemsLoading, setEmployeePickItemsLoading] = useState(false);
  const [employeePickItemsError, setEmployeePickItemsError] = useState("");
  const [employeePickScanValue, setEmployeePickScanValue] = useState("");
  const [employeePickScanBusy, setEmployeePickScanBusy] = useState(false);
  const [employeePickScanError, setEmployeePickScanError] = useState("");
  const [employeePickFinishBusy, setEmployeePickFinishBusy] = useState(false);
  const [employeePickFinishError, setEmployeePickFinishError] = useState("");
  const [employeePickIssueOpen, setEmployeePickIssueOpen] = useState(false);
  const [employeePickIssueValue, setEmployeePickIssueValue] = useState("");
  const [employeePickIssueItemId, setEmployeePickIssueItemId] = useState("");
  const [employeePickIssueBusy, setEmployeePickIssueBusy] = useState(false);
  const [employeePickIssueError, setEmployeePickIssueError] = useState("");
  const [employeePickManualBusyId, setEmployeePickManualBusyId] = useState(null);
  const [employeeLookupValue, setEmployeeLookupValue] = useState("");
  const [employeeLookupBusy, setEmployeeLookupBusy] = useState(false);
  const [employeeLookupError, setEmployeeLookupError] = useState("");
  const [employeeIssueOpen, setEmployeeIssueOpen] = useState(false);
  const [employeeIssueValue, setEmployeeIssueValue] = useState("");
  const [employeeIssueBusy, setEmployeeIssueBusy] = useState(false);
  const [employeeIssueError, setEmployeeIssueError] = useState("");
  const [employeeIssueLineNos, setEmployeeIssueLineNos] = useState([]);
  const [employeeOrders, setEmployeeOrders] = useState([]);
  const [employeeOrdersLoading, setEmployeeOrdersLoading] = useState(false);
  const [employeeOrdersError, setEmployeeOrdersError] = useState("");
  const [employeeSelectedOrder, setEmployeeSelectedOrder] = useState(null);
  const [scanValue, setScanValue] = useState("");
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState("");
  const [labelScanValue, setLabelScanValue] = useState("");
  const [labelScanBusy, setLabelScanBusy] = useState(false);
  const [labelScanError, setLabelScanError] = useState("");
  const [scanIssues, setScanIssues] = useState([]);
  const [scanIssuesLoading, setScanIssuesLoading] = useState(false);
  const [scanIssuesError, setScanIssuesError] = useState("");
  const [scanIssueActionBusyId, setScanIssueActionBusyId] = useState(null);
  const [employeeStatsUser, setEmployeeStatsUser] = useState(null);
  const [employeeStatsData, setEmployeeStatsData] = useState(null);
  const [employeeStatsLoading, setEmployeeStatsLoading] = useState(false);
  const [employeeStatsError, setEmployeeStatsError] = useState("");
  const [employeeStatsRangeKey, setEmployeeStatsRangeKey] = useState("today");
  const [employeeStatsCustomFrom, setEmployeeStatsCustomFrom] = useState("");
  const [employeeStatsCustomTo, setEmployeeStatsCustomTo] = useState("");
  const scanInputRef = useRef(null);
  const labelScanInputRef = useRef(null);
  const employeeLookupInputRef = useRef(null);
  const employeeIssueInputRef = useRef(null);
  const employeePickScanInputRef = useRef(null);
  const employeePickIssueInputRef = useRef(null);
  const fbsStockPollRef = useRef(null);
  const scanTimerRef = useRef(null);
  const labelScanTimerRef = useRef(null);
  const employeeLookupTimerRef = useRef(null);
  const employeePickScanTimerRef = useRef(null);
  const employeePickIssueTimerRef = useRef(null);
  const employeePickFeedbackAudioRef = useRef(null);
  const employeePickFocusGuardRef = useRef({ canFocus: false });
  const selectedAssemblyRef = useRef(null);
  const selectedAssemblyTabRef = useRef("orders");
  const employeeSelectedAssemblyRef = useRef(null);
  const employeeSelectedOrderRef = useRef(null);
  const employeeLastAssembliesRefreshRef = useRef(0);
  const employeeLastOrdersRefreshRef = useRef(0);
  const employeeLastSessionRefreshRef = useRef(0);
  const employeeLiveRefreshBlockedUntilRef = useRef(0);
  const employeePickListBodyRef = useRef(null);
  const employeePickScrollRestoreRef = useRef(null);

  const isSuper = currentUser?.role === "super_admin";
  const isAdmin = currentUser?.role === "admin";
  const isEmployee = currentUser?.role === "employee";
  const isCollectorEmployee =
    isEmployee && normalizeEmployeePosition(currentUser?.position) === EMPLOYEE_POSITION_COLLECTOR;
  const usersRoleFilter = isSuper ? (userTab === "admins" ? "admin" : "employee") : "employee";

  const handleAuthError = (err) => {
    if (err?.status === 401) {
      setCurrentUser(null);
      setAuthChecked(true);
      return true;
    }
    return false;
  };

  const shouldRefreshEmployee = (ref, minMs = 1500) => {
    const now = Date.now();
    const last = Number(ref.current || 0);
    if (now - last < minMs) return false;
    ref.current = now;
    return true;
  };

  const suppressEmployeeLiveRefresh = (ms = 1200) => {
    employeeLiveRefreshBlockedUntilRef.current = Date.now() + Math.max(0, Number(ms) || 0);
  };

  const rememberEmployeePickScroll = (anchorItemId = null) => {
    const body = employeePickListBodyRef.current;
    if (!body) return;
    employeePickScrollRestoreRef.current = {
      top: body.scrollTop,
      pageY:
        typeof window !== "undefined"
          ? window.scrollY ?? window.pageYOffset ?? document.documentElement?.scrollTop ?? 0
          : 0,
      anchorItemId: Number.isFinite(Number(anchorItemId)) ? Number(anchorItemId) : null,
    };
  };

  const applyEmployeePickScrollSnapshot = (snapshot) => {
    const body = employeePickListBodyRef.current;
    if (!body || !snapshot) return;
    body.scrollTop = snapshot.top;
    if (typeof window !== "undefined") {
      try {
        window.scrollTo(0, Number(snapshot.pageY) || 0);
      } catch {
        // Ignore browser scroll restoration failures.
      }
    }
    if (!Number.isFinite(snapshot.anchorItemId) || snapshot.anchorItemId <= 0) return;
    const target = body.querySelector(`[data-pick-item-id="${snapshot.anchorItemId}"]`);
    if (!target) return;
    const bodyRect = body.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    if (targetRect.top < bodyRect.top || targetRect.bottom > bodyRect.bottom) {
      target.scrollIntoView({ block: "nearest" });
    }
  };

  const restoreEmployeePickScroll = () => {
    const snapshot = employeePickScrollRestoreRef.current;
    if (!snapshot) return;
    [0, 80, 220].forEach((delay, index, list) => {
      setTimeout(() => {
        applyEmployeePickScrollSnapshot(snapshot);
        if (index === list.length - 1 && employeePickScrollRestoreRef.current === snapshot) {
          employeePickScrollRestoreRef.current = null;
        }
      }, delay);
    });
  };

  const canKeepEmployeePickScanFocus =
    employeeAssemblySession?.workflow?.currentStage === "picking" &&
    !employeeSelectedOrder &&
    !employeePickIssueOpen &&
    !employeePickIssueBusy &&
    !employeePickFinishBusy;

  const queueEmployeePickScanFocus = (delays = [0, 80, 220, 480]) => {
    delays.forEach((delay) => {
      setTimeout(() => {
        if (!employeePickFocusGuardRef.current.canFocus) return;
        const input = employeePickScanInputRef.current;
        if (!input) return;
        try {
          input.focus({ preventScroll: true });
        } catch {
          try {
            input.focus();
          } catch {
            // Ignore focus race conditions while the list is rerendering.
          }
        }
      }, delay);
    });
  };

  const handleEmployeePickScanInputBlur = () => {
    if (!employeePickFocusGuardRef.current.canFocus) return;
    queueEmployeePickScanFocus([120, 320]);
  };

  const playEmployeePickFeedbackTone = (kind = "success") => {
    if (typeof window === "undefined") return;
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;
    let audioContext = employeePickFeedbackAudioRef.current;
    if (!audioContext) {
      try {
        audioContext = new AudioContextCtor();
      } catch {
        return;
      }
      employeePickFeedbackAudioRef.current = audioContext;
    }
    const scheduleNotes = () => {
      const now = audioContext.currentTime;
      const notes =
        kind === "error"
          ? [
              { frequency: 220, offset: 0, duration: 0.1, gain: 0.08, type: "sawtooth" },
              { frequency: 165, offset: 0.11, duration: 0.16, gain: 0.07, type: "triangle" },
            ]
          : [
              { frequency: 880, offset: 0, duration: 0.07, gain: 0.05, type: "sine" },
              { frequency: 1174, offset: 0.08, duration: 0.09, gain: 0.045, type: "sine" },
            ];
      notes.forEach((note) => {
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        oscillator.type = note.type;
        oscillator.frequency.setValueAtTime(note.frequency, now + note.offset);
        gainNode.gain.setValueAtTime(0.0001, now + note.offset);
        gainNode.gain.exponentialRampToValueAtTime(note.gain, now + note.offset + 0.01);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, now + note.offset + note.duration);
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        oscillator.start(now + note.offset);
        oscillator.stop(now + note.offset + note.duration + 0.02);
      });
    };
    if (audioContext.state === "suspended") {
      audioContext.resume().then(scheduleNotes).catch(() => {});
      return;
    }
    scheduleNotes();
  };

  const storeHeaders = useMemo(() => buildStoreHeaders(storeId), [storeId]);
  const adminFetch = (url, options = {}) =>
    fetchJson(url, {
      ...options,
      headers: { ...storeHeaders, ...(options.headers || {}) },
    });

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return undefined;
    const unlockAudio = () => {
      let audioContext = employeePickFeedbackAudioRef.current;
      if (!audioContext) {
        try {
          audioContext = new AudioContextCtor();
        } catch {
          return;
        }
        employeePickFeedbackAudioRef.current = audioContext;
      }
      if (audioContext.state === "suspended") {
        audioContext.resume().catch(() => {});
      }
    };
    window.addEventListener("pointerdown", unlockAudio, { passive: true });
    window.addEventListener("keydown", unlockAudio);
    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    };
  }, []);

  useEffect(() => {
    let active = true;
    fetchJson(`${API_BASE}/auth/me`)
      .then((data) => {
        if (!active) return;
        setCurrentUser(data?.user || null);
        setAuthChecked(true);
      })
      .catch(() => {
        if (!active) return;
        setAuthChecked(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    fetchJson(`${API_BASE}/stores`)
      .then((data) => {
        if (!active) return;
        const stores = Array.isArray(data?.stores) ? data.stores : [];
        setStoreOptions(stores);
        const defaultId = data?.defaultStoreId || stores[0]?.id || "";
        let next = storeId || defaultId;
        if (next && !stores.find((store) => store.id === next)) {
          next = defaultId;
        }
        if (next && next !== storeId) {
          setStoreId(next);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [isAdmin, storeId]);

  useEffect(() => {
    if (!isAdmin) return;
    if (storeId) {
      window.localStorage.setItem("oz_store_id", storeId);
    }
  }, [isAdmin, storeId]);

  useEffect(() => {
    if (!isAdmin) return;
    setSelectedAssembly(null);
    setAssemblies([]);
    setNewOrders([]);
    setNewError("");
    setAssembliesError("");
    setScanIssues([]);
    setScanIssuesError("");
  }, [isAdmin, storeId]);

  const loadUsers = async () => {
    if (!currentUser || (!isSuper && !isAdmin)) return;
    setUsersLoading(true);
    setUsersError("");
    try {
      const roleParam = isSuper ? `?role=${usersRoleFilter}` : "";
      const data = await fetchJson(`${API_BASE}/users${roleParam}`);
      setUsers(Array.isArray(data?.users) ? data.users : []);
    } catch (err) {
      if (handleAuthError(err)) return;
      setUsersError("Не удалось загрузить пользователей");
    } finally {
      setUsersLoading(false);
    }
  };

  const loadNewOrders = async ({ silent = false } = {}) => {
    if (!isAdmin || !storeId) return;
    if (!silent) setNewLoading(true);
    if (!silent) setNewError("");
    try {
      const data = await adminFetch(`${API_BASE}/new-orders`);
      setNewOrders(Array.isArray(data?.orders) ? data.orders : []);
      setNewUpdatedAt(new Date());
    } catch (err) {
      if (handleAuthError(err)) return;
      if (!silent || newOrders.length === 0) {
        setNewError(err?.message || "Не удалось загрузить новые заказы");
      }
    } finally {
      if (!silent) setNewLoading(false);
    }
  };

  const loadAssemblies = async ({ silent = false } = {}) => {
    if (!isAdmin || !storeId) return;
    if (!silent) setAssembliesLoading(true);
    if (!silent) setAssembliesError("");
    try {
      const data = await adminFetch(`${API_BASE}/assemblies`);
      const nextAssemblies = Array.isArray(data?.assemblies) ? data.assemblies : [];
      setAssemblies(nextAssemblies);
      setSelectedAssembly((prev) => {
        if (!prev) return prev;
        return nextAssemblies.find((item) => item.id === prev.id) || prev;
      });
    } catch (err) {
      if (handleAuthError(err)) return;
      if (!silent || assemblies.length === 0) {
        setAssembliesError(err?.message || "Не удалось загрузить сборки");
      }
    } finally {
      if (!silent) setAssembliesLoading(false);
    }
  };

  const loadFbsStockCheck = async ({ force = false, silent = false, progressOnly = false } = {}) => {
    if (!isAdmin) return;
    if (!silent && !progressOnly) {
      setFbsStockLoading(true);
      setFbsStockError("");
    }
    try {
      const params = new URLSearchParams();
      if (force) {
        params.set("refresh", "1");
      } else if (progressOnly) {
        params.set("progress", "1");
      }
      const qs = params.toString();
      const data = await adminFetch(`${API_BASE}/fbs-stock-check${qs ? `?${qs}` : ""}`);
      const items = Array.isArray(data?.items) ? data.items : [];
      const scopeStores = Array.isArray(data?.scopeStores)
        ? data.scopeStores
            .map((store) => ({
              id: String(store?.id || "").trim(),
              name: String(store?.name || store?.id || "").trim(),
            }))
            .filter((store) => store.id)
        : [];
      setFbsStockItems(items);
      setFbsStockScopeStores(scopeStores);
      setFbsStockWarehouseName(String(data?.warehouseName || "Ижевск FBS"));
      setFbsStockTotals({
        all: Number(data?.totals?.all || items.length || 0),
        ok: Number(data?.totals?.ok || 0),
        shortage: Number(data?.totals?.shortage || 0),
        errors: Number(data?.totals?.errors || 0),
      });
      setFbsStockUpdatedAt(data?.updatedAt ? new Date(data.updatedAt) : null);
      const isRunning = Boolean(data?.running);
      const progress = normalizeFbsProgress(
        { ...(data?.progress || {}), running: isRunning },
        isRunning
      );
      setFbsStockProgress(progress);
      setFbsStockRefreshing(isRunning || progress.running);
      if (data?.error && !isRunning) {
        setFbsStockError(String(data.error));
      } else if (!silent && !progressOnly) {
        setFbsStockError("");
      }
    } catch (err) {
      if (handleAuthError(err)) return;
      if (!silent || !progressOnly) {
        setFbsStockError(err?.message || "Не удалось загрузить проверку остатков ФБС.");
      }
      setFbsStockRefreshing(false);
    } finally {
      if (!silent && !progressOnly) setFbsStockLoading(false);
    }
  };

  const loadStockProblems = async ({ silent = false } = {}) => {
    if (!isAdmin) return;
    if (!silent) {
      setStockProblemsLoading(true);
      setStockProblemsError("");
    }
    try {
      const data = await adminFetch(`${API_BASE}/stock-problems`);
      setStockProblems({
        negativeShelves: Array.isArray(data?.negativeShelves) ? data.negativeShelves : [],
        negativeEmployees: Array.isArray(data?.negativeEmployees) ? data.negativeEmployees : [],
        leftoverEmployees: Array.isArray(data?.leftoverEmployees) ? data.leftoverEmployees : [],
      });
      setStockProblemsUpdatedAt(data?.generatedAt ? new Date(data.generatedAt) : null);
      if (!silent) setStockProblemsError("");
    } catch (err) {
      if (handleAuthError(err)) return;
      if (!silent) {
        setStockProblemsError(err?.message || "Не удалось загрузить проблемы остатков.");
      }
    } finally {
      if (!silent) setStockProblemsLoading(false);
    }
  };

  const handleSyncAwaitingDeliver = async ({ loadLabels = true } = {}) => {
    if (!isAdmin || !storeId) return;
    setSyncBusy(true);
    setSyncError("");
    setSyncInfo("");
    try {
      const data = await adminFetch(`${API_BASE}/assemblies/sync-awaiting-deliver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loadLabels }),
      });
      const localTotalAfter = Number.isFinite(Number(data?.localTotalAfter))
        ? Number(data.localTotalAfter)
        : null;
      const rechecked = Number.isFinite(Number(data?.rechecked)) ? Number(data.rechecked) : null;
      const message = `В Ozon: ${data?.totalFromOzon || 0}, в локальной сборке: ${
        localTotalAfter === null ? "нет данных" : localTotalAfter
      }, добавлено: ${data?.inserted || 0}, обновлено: ${data?.updated || 0}, удалено неактуальных: ${
        data?.removed || 0
      }, перепроверено: ${rechecked === null ? "нет данных" : rechecked}`;
      setSyncInfo(message);
      await loadAssemblies({ silent: true });
      await loadNewOrders({ silent: true });
      if (data?.assemblyId) {
        const target = (assemblies || []).find((item) => item.id === data.assemblyId) || {
          id: data.assemblyId,
          name: "Синхронизация Ozon · Ожидают отгрузки",
        };
        setSelectedAssembly(target);
        setAssemblyTab("orders");
        loadAssemblyOrders(data.assemblyId);
        loadAssemblySettings(data.assemblyId);
        loadAssemblyLabelDiagnostics(data.assemblyId);
      }
    } catch (err) {
      if (handleAuthError(err)) return;
      setSyncError(err?.message || "Не удалось синхронизировать заказы из Ozon");
    } finally {
      setSyncBusy(false);
    }
  };

  const loadAssemblyOrders = async (assemblyId, { silent = false } = {}) => {
    if (!assemblyId) return;
    if (!silent) setAssemblyOrdersLoading(true);
    setAssemblyOrdersError("");
    try {
      const data = await adminFetch(`${API_BASE}/assemblies/${encodeURIComponent(assemblyId)}/orders`);
      const orders = Array.isArray(data?.orders) ? data.orders : [];
      setAssemblyOrders(orders);
      return orders;
    } catch (err) {
      if (handleAuthError(err)) return;
      setAssemblyOrdersError(err?.message || "Не удалось загрузить заказы сборки");
      return [];
    } finally {
      if (!silent) setAssemblyOrdersLoading(false);
    }
  };

  const loadAssemblySettings = async (assemblyId, { silent = false, preserveEditorState = false } = {}) => {
    if (!assemblyId) return;
    if (!silent) setAssemblySettingsLoading(true);
    if (!silent) setAssemblySettingsError("");
    try {
      const data = await adminFetch(`${API_BASE}/assemblies/${encodeURIComponent(assemblyId)}/settings`);
      setAssemblySettings(data?.settings || null);
      setAssemblyTotals(data?.totals || { total: 0, collected: 0, remaining: 0, readyToShip: 0 });
      setAssemblyEmployees(Array.isArray(data?.employees) ? data.employees : []);
      setAssemblyProgress(Array.isArray(data?.progress) ? data.progress : []);
      setAssemblySettingsError("");
      if (!preserveEditorState || !assemblyAccessDirty) {
        const ids = Array.isArray(data?.accessUserIds) ? data.accessUserIds : [];
        setAccessUsers(ids.map(Number));
        setAccessMode(data?.settings?.accessMode === "selected_split" ? "selected_split" : "hidden");
        setAssemblyAccessDirty(false);
      }
    } catch (err) {
      if (handleAuthError(err)) return;
      if (!silent) {
        setAssemblySettingsError(err?.message || "Не удалось загрузить настройки сборки");
      }
    } finally {
      if (!silent) setAssemblySettingsLoading(false);
    }
  };

  const loadAssemblyLabelDiagnostics = async (assemblyId, { silent = false } = {}) => {
    if (!assemblyId) return null;
    if (!silent) setAssemblyLabelDiagnosticsLoading(true);
    if (!silent) setAssemblyLabelDiagnosticsError("");
    try {
      const data = await adminFetch(`${API_BASE}/assemblies/${encodeURIComponent(assemblyId)}/labels/diagnostics`);
      setAssemblyLabelDiagnostics(data?.diagnostics || null);
      setAssemblyLabelDiagnosticsError("");
      return data?.diagnostics || null;
    } catch (err) {
      if (handleAuthError(err)) return null;
      if (!silent) setAssemblyLabelDiagnosticsError(err?.message || "Не удалось загрузить диагностику этикеток");
      return null;
    } finally {
      if (!silent) setAssemblyLabelDiagnosticsLoading(false);
    }
  };
  const loadEmployeeAssemblies = async ({ silent = false } = {}) => {
    if (!isEmployee) return;
    if (!silent) setEmployeeAssembliesLoading(true);
    if (!silent) setEmployeeAssembliesError("");
    try {
      const data = await fetchJson(`${API_BASE}/employee/assemblies`);
      const assemblies = Array.isArray(data?.assemblies) ? data.assemblies : [];
      setEmployeeAssemblies(assemblies);
      return assemblies;
    } catch (err) {
      if (handleAuthError(err)) return;
      setEmployeeAssembliesError(err?.message || "Не удалось загрузить сборки");
      return [];
    } finally {
      if (!silent) setEmployeeAssembliesLoading(false);
    }
  };

  const loadEmployeeOrders = async (assemblyId, { silent = false } = {}) => {
    if (!assemblyId) return;
    if (!silent) setEmployeeOrdersLoading(true);
    if (!silent) setEmployeeOrdersError("");
    try {
      const data = await fetchJson(`${API_BASE}/employee/assemblies/${encodeURIComponent(assemblyId)}/orders`);
      const orders = Array.isArray(data?.orders) ? data.orders : [];
      setEmployeeOrders(orders);
      setEmployeeSelectedOrder((prev) => {
        if (!prev) return null;
        return orders.find((o) => o.postingNumber === prev.postingNumber) || null;
      });
      return orders;
    } catch (err) {
      if (handleAuthError(err)) return;
      setEmployeeOrdersError(err?.message || "Не удалось загрузить заказы");
      return [];
    } finally {
      if (!silent) setEmployeeOrdersLoading(false);
    }
  };

  const loadEmployeeAssemblySession = async (assemblyId, { silent = false } = {}) => {
    if (!assemblyId) return null;
    if (!silent) setEmployeeAssemblySessionLoading(true);
    if (!silent) setEmployeeAssemblySessionError("");
    if (!silent) setEmployeeStartError("");
    try {
      const data = await fetchJson(`${API_BASE}/employee/assemblies/${encodeURIComponent(assemblyId)}/session`);
      setEmployeeAssemblySession(data || null);
      return data || null;
    } catch (err) {
      if (handleAuthError(err)) return null;
      if (!silent) {
        setEmployeeAssemblySessionError(err?.message || "Не удалось загрузить состояние сборки");
      }
      return null;
    } finally {
      if (!silent) setEmployeeAssemblySessionLoading(false);
    }
  };

  const loadEmployeePickItems = async (assemblyId, { silent = false } = {}) => {
    if (!assemblyId) return [];
    if (!silent) {
      setEmployeePickItemsLoading(true);
      setEmployeePickItemsError("");
      setEmployeePickFinishError("");
    }
    try {
      const data = await fetchJson(`${API_BASE}/employee/assemblies/${encodeURIComponent(assemblyId)}/pick-items`);
      const items = Array.isArray(data?.items) ? data.items : [];
      rememberEmployeePickScroll();
      setEmployeePickItems(sortEmployeePickItems(items));
      restoreEmployeePickScroll();
      if (data?.session) {
        setEmployeeAssemblySession((prev) => (prev ? { ...prev, session: data.session } : prev));
      }
      return items;
    } catch (err) {
      if (handleAuthError(err)) return [];
      if (!silent) {
        setEmployeePickItemsError(err?.message || "Не удалось загрузить сборку товара");
      }
      return [];
    } finally {
      if (!silent) setEmployeePickItemsLoading(false);
    }
  };

  const upsertEmployeeOrderState = (order) => {
    if (!order?.postingNumber) return;
    setEmployeeOrders((prev) => {
      const list = Array.isArray(prev) ? [...prev] : [];
      const index = list.findIndex((item) => item.postingNumber === order.postingNumber);
      if (index >= 0) {
        list[index] = order;
      } else {
        list.unshift(order);
      }
      return list;
    });
    setEmployeeSelectedOrder((prev) => {
      if (!prev || prev.postingNumber !== order.postingNumber) return prev;
      return order;
    });
  };

  const removeEmployeeOrderState = (postingNumber) => {
    if (!postingNumber) return;
    setEmployeeOrders((prev) => (Array.isArray(prev) ? prev.filter((item) => item.postingNumber !== postingNumber) : []));
    setEmployeeSelectedOrder((prev) => (prev?.postingNumber === postingNumber ? null : prev));
  };

  const loadScanIssues = async ({ silent = false } = {}) => {
    if (!isAdmin || !storeId) return [];
    if (!silent) setScanIssuesLoading(true);
    if (!silent) setScanIssuesError("");
    try {
      const data = await adminFetch(`${API_BASE}/settings/scan-issues`);
      const issues = Array.isArray(data?.issues) ? data.issues : [];
      setScanIssues(issues);
      return issues;
    } catch (err) {
      if (handleAuthError(err)) return [];
      if (!silent) setScanIssuesError(err?.message || "Не удалось загрузить ошибки сотрудников");
      return [];
    } finally {
      if (!silent) setScanIssuesLoading(false);
    }
  };

  const loadEmployeeStats = async (
    user,
    { rangeKey = employeeStatsRangeKey, customFrom = employeeStatsCustomFrom, customTo = employeeStatsCustomTo } = {}
  ) => {
    if (!user?.id) return;
    const range = resolveStatsRange(rangeKey, customFrom, customTo);
    setEmployeeStatsLoading(true);
    setEmployeeStatsError("");
    try {
      const params = new URLSearchParams();
      if (range.from) params.set("from", range.from);
      if (range.to) params.set("to", range.to);
      const qs = params.toString();
      const data = await fetchJson(`${API_BASE}/users/${user.id}/stats${qs ? `?${qs}` : ""}`);
      setEmployeeStatsData(data || null);
    } catch (err) {
      if (handleAuthError(err)) return;
      setEmployeeStatsError(err?.message || "Не удалось загрузить статистику сотрудника");
    } finally {
      setEmployeeStatsLoading(false);
    }
  };

  useEffect(() => {
    if (!currentUser) return;
    if (isSuper || isAdmin) {
      loadUsers();
      loadUserDirectory();
    }
    if (isAdmin) {
      loadNewOrders();
      loadAssemblies();
      loadFbsStockCheck({ silent: true });
      loadStockProblems({ silent: true });
      loadScanIssues();
    }
    if (isEmployee && !isCollectorEmployee) {
      loadEmployeeAssemblies();
    }
  }, [currentUser, storeId, isEmployee, isCollectorEmployee]);

  useEffect(() => {
    if (!isAdmin) return;
    const t1 = setInterval(() => loadNewOrders({ silent: true }), REFRESH_NEW_MS);
    const t2 = setInterval(() => {
      loadAssemblies({ silent: true });
      loadScanIssues({ silent: true });
      const openedAssembly = selectedAssemblyRef.current;
      if (!openedAssembly) return;
      const settingsTabOpen = selectedAssemblyTabRef.current === "settings";
      if (!settingsTabOpen) {
        loadAssemblyOrders(openedAssembly.id, { silent: true });
      }
      loadAssemblySettings(openedAssembly.id, {
        silent: true,
        preserveEditorState: settingsTabOpen && (assemblyAccessDirty || settingsBusy),
      });
      loadAssemblyLabelDiagnostics(openedAssembly.id, { silent: true });
    }, REFRESH_ASSEMBLIES_MS);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
    };
  }, [isAdmin, storeId, assemblyAccessDirty, settingsBusy]);

  useEffect(() => {
    if (fbsStockPollRef.current) {
      clearInterval(fbsStockPollRef.current);
      fbsStockPollRef.current = null;
    }
    if (!isAdmin || !storeId || !fbsStockRefreshing) return undefined;
    fbsStockPollRef.current = setInterval(() => {
      loadFbsStockCheck({ silent: true, progressOnly: true });
    }, 1500);
    return () => {
      if (fbsStockPollRef.current) {
        clearInterval(fbsStockPollRef.current);
        fbsStockPollRef.current = null;
      }
    };
  }, [isAdmin, storeId, fbsStockRefreshing]);

  useEffect(() => {
    if (!isAdmin || tab !== "stock_problems") return;
    loadStockProblems();
  }, [isAdmin, tab]);

  useEffect(() => {
    if (!isAdmin || tab !== "stock_problems") return undefined;
    const refresh = () => loadStockProblems({ silent: true });
    const timer = setInterval(refresh, 15000);
    const handleFocus = () => refresh();
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleFocus);
    };
  }, [isAdmin, tab]);

  useEffect(() => {
    if (!isEmployee || isCollectorEmployee) return;
    const timer = setInterval(() => {
      const openedAssembly = employeeSelectedAssemblyRef.current;
      if (!openedAssembly) {
        if (shouldRefreshEmployee(employeeLastAssembliesRefreshRef, 3000)) {
          loadEmployeeAssemblies({ silent: true });
        }
        return;
      }
      if (Date.now() < employeeLiveRefreshBlockedUntilRef.current) return;
      const refreshSession = shouldRefreshEmployee(employeeLastSessionRefreshRef, 2000);
      const refreshOrders = shouldRefreshEmployee(employeeLastOrdersRefreshRef, 2000);
      if (!refreshSession && !refreshOrders) return;
      loadEmployeeAssemblySession(openedAssembly.id, { silent: true }).then((sessionData) => {
        const currentStage = sessionData?.workflow?.currentStage || "";
        if (currentStage === "picking") {
          if (refreshOrders) {
            loadEmployeePickItems(openedAssembly.id, { silent: true });
          }
          return;
        }
        if (employeeSelectedOrderRef.current) return;
        if (refreshOrders) {
          loadEmployeeOrders(openedAssembly.id, { silent: true });
        }
      });
    }, REFRESH_EMPLOYEE_MS);
    return () => clearInterval(timer);
  }, [isEmployee, isCollectorEmployee]);

  useEffect(() => {
    if (!currentUser) return undefined;
    const source = new EventSource(`${API_BASE}/events`, { withCredentials: true });
    source.addEventListener("assembly_update", (event) => {
      let payload = null;
      try {
        payload = JSON.parse(event.data || "{}");
      } catch {
        payload = null;
      }
      const assemblyId = payload?.assemblyId || null;
      if (isAdmin) {
        loadAssemblies({ silent: true });
        const openedAssembly = selectedAssemblyRef.current;
        if (openedAssembly && (!assemblyId || openedAssembly.id === assemblyId)) {
          if (selectedAssemblyTabRef.current !== "settings") {
            loadAssemblyOrders(openedAssembly.id, { silent: true });
          }
          loadAssemblySettings(openedAssembly.id, {
            silent: true,
            preserveEditorState: selectedAssemblyTabRef.current === "settings" && (assemblyAccessDirty || settingsBusy),
          });
          loadAssemblyLabelDiagnostics(openedAssembly.id, { silent: true });
        }
      }
      if (isEmployee && !isCollectorEmployee) {
        const openedAssembly = employeeSelectedAssemblyRef.current;
        if (!openedAssembly) {
          if (shouldRefreshEmployee(employeeLastAssembliesRefreshRef, 1800)) {
            loadEmployeeAssemblies({ silent: true });
          }
        } else if (!assemblyId || openedAssembly.id === assemblyId) {
          if (Date.now() < employeeLiveRefreshBlockedUntilRef.current) return;
          const refreshSession = shouldRefreshEmployee(employeeLastSessionRefreshRef, 1000);
          const refreshOrders = shouldRefreshEmployee(employeeLastOrdersRefreshRef, 1000);
          if (!refreshSession && !refreshOrders) return;
          loadEmployeeAssemblySession(openedAssembly.id, { silent: true }).then((sessionData) => {
            const currentStage = sessionData?.workflow?.currentStage || "";
            if (currentStage === "picking") {
              if (refreshOrders) {
                loadEmployeePickItems(openedAssembly.id, { silent: true });
              }
              return;
            }
            if (!employeeSelectedOrderRef.current && refreshOrders) {
              loadEmployeeOrders(openedAssembly.id, { silent: true });
            }
          });
        }
      }
    });
    source.addEventListener("scan_issue_update", () => {
      if (isAdmin) loadScanIssues({ silent: true });
    });
    source.addEventListener("scan_issue_fixed", (event) => {
      let payload = {};
      try {
        payload = JSON.parse(event.data || "{}");
      } catch {
        payload = {};
      }
      if (isAdmin) loadScanIssues({ silent: true });
      const openedAssembly = employeeSelectedAssemblyRef.current;
      if (isEmployee && !isCollectorEmployee && openedAssembly && payload?.assemblyId === openedAssembly.id) {
        if (payload?.issueStage === "pick_scan") {
          const fixedPickItemId = Number(payload?.pickItemId);
          if (Number.isFinite(fixedPickItemId) && fixedPickItemId > 0) {
            setEmployeePickItems((prev) =>
              sortEmployeePickItems(
                prev.map((item) =>
                  Number(item.id) === fixedPickItemId ? { ...item, bypassWithoutScanAllowed: true } : item
                )
              )
            );
          }
          setEmployeePickIssueError("");
          setEmployeePickIssueOpen(false);
          setEmployeePickIssueValue("");
          setEmployeePickIssueItemId("");
          setEmployeeFlowNotice("Админ разрешил собрать один товар без штрихкода. Используйте кнопку «Собрать без шк».");
          return;
        }
        loadEmployeeOrders(openedAssembly.id, { silent: true });
        loadEmployeeAssemblySession(openedAssembly.id, { silent: true });
        setEmployeeIssueOpen(false);
        setEmployeeIssueValue("");
        setEmployeeIssueError("");
        setEmployeeIssueLineNos([]);
        setScanError("");
        setEmployeeFlowWarning("");
        setEmployeeFlowNotice("Админ выполнил фикс. Можно продолжать сборку.");
      }
    });
    return () => {
      source.close();
    };
  }, [currentUser, isAdmin, isEmployee, isCollectorEmployee, storeId, assemblyAccessDirty, settingsBusy]);

  const handleLogin = async () => {
    setLoginError("");
    if (!loginSurname.trim() || !loginPassword) {
      setLoginError("Введите логин и пароль");
      return;
    }
    setLoginBusy(true);
    try {
      const data = await fetchJson(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login: loginSurname.trim(), password: loginPassword }),
      });
      setCurrentUser(data?.user || null);
      setLoginPassword("");
      setAuthChecked(true);
    } catch (err) {
      setLoginError(err?.message || "Ошибка входа");
    } finally {
      setLoginBusy(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetchJson(`${API_BASE}/auth/logout`, { method: "POST" });
    } catch {
      // Ignore logout transport errors and drop local session state anyway.
    }
    setCurrentUser(null);
    setSelectedAssembly(null);
    setEmployeeSelectedAssembly(null);
  };

  const loadUserDirectory = async () => {
    if (!currentUser || (!isSuper && !isAdmin)) return;
    setUserDirectoryLoading(true);
    setUserDirectoryError("");
    try {
      const data = await fetchJson(`${API_BASE}/users/directory`);
      setUserDirectory(Array.isArray(data?.users) ? data.users : []);
    } catch (err) {
      if (handleAuthError(err)) return;
      setUserDirectoryError(err?.message || "Не удалось загрузить сотрудников из общей базы");
    } finally {
      setUserDirectoryLoading(false);
    }
  };

  const handleEmployeeStart = async () => {
    if (!employeeSelectedAssembly || employeeStartBusy) return;
    setEmployeeStartBusy(true);
    setEmployeeStartError("");
    setEmployeeFlowNotice("");
    setEmployeeFlowWarning("");
    try {
      const data = await fetchJson(`${API_BASE}/employee/assemblies/${encodeURIComponent(employeeSelectedAssembly.id)}/start`, {
        method: "POST",
      });
      suppressEmployeeLiveRefresh();
      const nextSession = data?.session || null;
      const nextWorkflow = data?.workflow || null;
      const currentStage = nextWorkflow?.currentStage || "";
      setEmployeeAssemblySession((prev) => ({
        ...(prev || {}),
        assembly:
          prev?.assembly || {
            id: employeeSelectedAssembly.id,
            name: employeeSelectedAssembly.name || null,
            storeId: employeeSelectedAssembly.storeId || null,
            storeName: employeeSelectedAssembly.storeName || null,
            total: employeeSelectedAssembly.total || 0,
            collected: employeeSelectedAssembly.collected || 0,
            remaining: employeeSelectedAssembly.remaining || 0,
          },
        session: nextSession,
        workflow: nextWorkflow,
        canStart: Boolean(nextWorkflow?.canStartPicking || nextWorkflow?.canStartPacking),
        canWork: currentStage === "packing",
        activeSession: prev?.activeSession || null,
      }));
      setEmployeeSelectedAssembly((prev) =>
        prev && prev.id === employeeSelectedAssembly.id
          ? patchEmployeeAssemblyWorkflowState(prev, nextSession, nextWorkflow)
          : prev
      );
      setEmployeeAssemblies((prev) =>
        prev.map((assembly) =>
          assembly.id === employeeSelectedAssembly.id
            ? patchEmployeeAssemblyWorkflowState(assembly, nextSession, nextWorkflow)
            : assembly
        )
      );
      if (currentStage === "picking") {
        setEmployeePickItems(sortEmployeePickItems(Array.isArray(data?.pickItems) ? data.pickItems : []));
        setEmployeeFlowNotice("Сборка товара начата. Соберите товары с полок перед упаковкой заказов.");
        queueEmployeePickScanFocus();
      } else {
        setEmployeePickItems([]);
        await loadEmployeeOrders(employeeSelectedAssembly.id, { silent: true });
        setEmployeeFlowNotice("Сборка заказов начата. Можно приступать к упаковке.");
      }
    } catch (err) {
      if (handleAuthError(err)) return;
      setEmployeeStartError(err?.message || "Не удалось начать сборку");
    } finally {
      setEmployeeStartBusy(false);
    }
  };

  const handleEmployeePickScan = async (value = employeePickScanValue) => {
    if (!employeeSelectedAssembly || employeePickScanBusy) return;
    const barcode = String(value || "").trim();
    if (!barcode) return;
    if (employeePickScanTimerRef.current) {
      clearTimeout(employeePickScanTimerRef.current);
      employeePickScanTimerRef.current = null;
    }
    setEmployeePickScanBusy(true);
    setEmployeePickScanError("");
    setEmployeeFlowWarning("");
    setEmployeePickIssueError("");
    try {
      const data = await fetchJson(
        `${API_BASE}/employee/assemblies/${encodeURIComponent(employeeSelectedAssembly.id)}/pick-scan`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ barcode }),
        }
      );
      suppressEmployeeLiveRefresh(1500);
      setEmployeePickScanValue("");
      setEmployeeFlowWarning(data?.warning || "");
      if (data?.item?.id) {
        rememberEmployeePickScroll(data.item.id);
        setEmployeePickItems((prev) => mergeEmployeePickItem(prev, data.item));
        restoreEmployeePickScroll();
      }
      if (data?.session) {
        setEmployeeAssemblySession((prev) => (prev ? { ...prev, session: data.session } : prev));
        setEmployeeSelectedAssembly((prev) =>
          prev && prev.id === employeeSelectedAssembly.id ? { ...prev, session: data.session } : prev
        );
        setEmployeeAssemblies((prev) =>
          prev.map((assembly) =>
            assembly.id === employeeSelectedAssembly.id ? { ...assembly, session: data.session } : assembly
          )
        );
      }
      setEmployeePickIssueOpen(false);
      setEmployeePickIssueValue("");
      setEmployeePickIssueItemId("");
      setEmployeePickIssueError("");
      playEmployeePickFeedbackTone("success");
      if (data?.completed) {
        setEmployeeFlowNotice("Все товары собраны. Нажмите «Завершить сборку товара».");
      } else if (data?.item?.productName) {
        setEmployeeFlowNotice(`Принято: ${data.item.productName}`);
      } else {
        setEmployeeFlowNotice("Товар принят в сборку.");
      }
    } catch (err) {
      if (handleAuthError(err)) return;
      const message =
        err?.message || "Не удалось учесть товар. Если это ваш товар, нажмите «Ошибка» и отправьте админу.";
      setEmployeePickScanError(message);
      setEmployeeFlowWarning(message);
      setEmployeePickScanValue("");
      playEmployeePickFeedbackTone("error");
    } finally {
      setEmployeePickScanBusy(false);
      queueEmployeePickScanFocus();
    }
  };

  const handleEmployeePickFinish = async () => {
    if (!employeeSelectedAssembly || employeePickFinishBusy) return;
    setEmployeePickFinishBusy(true);
    setEmployeePickFinishError("");
    setEmployeeFlowWarning("");
    try {
      await fetchJson(`${API_BASE}/employee/assemblies/${encodeURIComponent(employeeSelectedAssembly.id)}/pick-finish`, {
        method: "POST",
      });
      suppressEmployeeLiveRefresh();
      setEmployeePickItems([]);
      await Promise.all([
        loadEmployeeAssemblySession(employeeSelectedAssembly.id, { silent: true }),
        loadEmployeeAssemblies({ silent: true }),
      ]);
      setEmployeeFlowNotice("Сборка товара завершена. Теперь можно начать упаковку заказов.");
    } catch (err) {
      if (handleAuthError(err)) return;
      setEmployeePickFinishError(err?.message || "Не удалось завершить сборку товара");
    } finally {
      setEmployeePickFinishBusy(false);
    }
  };

  const handleEmployeeLookupScan = async (value = employeeLookupValue) => {
    if (!employeeSelectedAssembly || employeeLookupBusy) return;
    if (!employeeAssemblySession?.canWork) return;
    if (employeeLookupTimerRef.current) {
      clearTimeout(employeeLookupTimerRef.current);
      employeeLookupTimerRef.current = null;
    }
    const barcode = String(value || "").trim();
    if (!barcode) return;
    setEmployeeLookupBusy(true);
    setEmployeeLookupError("");
    setEmployeeFlowNotice("");
    try {
      const data = await fetchJson(`${API_BASE}/employee/assemblies/${encodeURIComponent(employeeSelectedAssembly.id)}/scan-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ barcode }),
      });
      const order = data?.order || null;
      if (!order?.postingNumber) {
        throw new Error("Не удалось открыть заказ");
      }
      setEmployeeLookupValue("");
      setEmployeeSelectedOrder(order);
      upsertEmployeeOrderState(order);
    } catch (err) {
      if (handleAuthError(err)) return;
      setEmployeeLookupError(err?.message || "Товар не найден в этой сборке");
      setEmployeeLookupValue("");
      if (employeeLookupInputRef.current) employeeLookupInputRef.current.focus();
    } finally {
      setEmployeeLookupBusy(false);
    }
  };

  const handleResolveScanIssue = async (issueId) => {
    if (!issueId || scanIssueActionBusyId) return;
    setScanIssueActionBusyId(issueId);
    setScanIssuesError("");
    try {
      await adminFetch(`${API_BASE}/settings/scan-issues/${issueId}/resolve`, {
        method: "POST",
      });
      setScanIssues((prev) => prev.filter((item) => item.id !== issueId));
    } catch (err) {
      if (handleAuthError(err)) return;
      setScanIssuesError(err?.message || "Не удалось отметить ошибку как решённую");
    } finally {
      setScanIssueActionBusyId(null);
    }
  };

  const handleFixScanIssue = async (issueId) => {
    if (!issueId || scanIssueActionBusyId) return;
    setScanIssueActionBusyId(issueId);
    setScanIssuesError("");
    try {
      await adminFetch(`${API_BASE}/settings/scan-issues/${issueId}/fix`, {
        method: "POST",
      });
      setScanIssues((prev) => prev.filter((item) => item.id !== issueId));
    } catch (err) {
      if (handleAuthError(err)) return;
      setScanIssuesError(err?.message || "Не удалось выполнить фикс");
    } finally {
      setScanIssueActionBusyId(null);
    }
  };

  const handleEmployeeIssueSubmit = async () => {
    if (!employeeSelectedAssembly || !employeeSelectedOrder || employeeIssueBusy) return;
    if (!employeeAssemblySession?.canWork) return;
    const barcode = employeeIssueValue.trim();
    if (!barcode) return;
    if (!employeeIssueLineNos.length) {
      setEmployeeIssueError("Выберите проблемный товар");
      return;
    }
    setEmployeeIssueBusy(true);
    setEmployeeIssueError("");
    try {
      await fetchJson(
        `${API_BASE}/employee/assemblies/${encodeURIComponent(employeeSelectedAssembly.id)}/orders/${encodeURIComponent(
          employeeSelectedOrder.postingNumber
        )}/scan-issue`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ barcode, lineNos: employeeIssueLineNos }),
        }
      );
      setEmployeeIssueOpen(false);
      setEmployeeIssueValue("");
      setEmployeeIssueLineNos([]);
      setEmployeeFlowNotice("Ошибка отправлена админу. Можно продолжить после фикса.");
    } catch (err) {
      if (handleAuthError(err)) return;
      setEmployeeIssueError(err?.message || "Не удалось отправить ошибку админу");
      if (employeeIssueInputRef.current) employeeIssueInputRef.current.focus();
    } finally {
      setEmployeeIssueBusy(false);
    }
  };

  const handleEmployeePickIssueSubmit = async (value = employeePickIssueValue) => {
    if (!employeeSelectedAssembly || employeePickIssueBusy) return;
    if (employeeAssemblySession?.workflow?.currentStage !== "picking") return;
    const barcode = String(value || "").trim();
    const pickItemId = Number(employeePickIssueItemId);
    if (!barcode) return;
    if (!Number.isFinite(pickItemId) || pickItemId < 1) {
      setEmployeePickIssueError("Выберите товар из списка");
      return;
    }
    setEmployeePickIssueBusy(true);
    setEmployeePickIssueError("");
    setEmployeeFlowWarning("");
    try {
      await fetchJson(
        `${API_BASE}/employee/assemblies/${encodeURIComponent(employeeSelectedAssembly.id)}/pick-issue`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ barcode, pickItemId }),
        }
      );
      suppressEmployeeLiveRefresh();
      setEmployeePickIssueOpen(false);
      setEmployeePickIssueValue("");
      setEmployeePickIssueItemId("");
      setEmployeePickIssueError("");
      setEmployeeFlowNotice("Ошибка сборки товара отправлена админу.");
      queueEmployeePickScanFocus();
    } catch (err) {
      if (handleAuthError(err)) return;
      setEmployeePickIssueError(err?.message || "Не удалось отправить ошибку админу");
      setEmployeePickIssueValue("");
      if (employeePickIssueInputRef.current) {
        employeePickIssueInputRef.current.focus();
      }
    } finally {
      setEmployeePickIssueBusy(false);
    }
  };

  const handleEmployeePickCollectWithoutScan = async (itemId) => {
    if (!employeeSelectedAssembly || !itemId || employeePickManualBusyId) return;
    setEmployeePickManualBusyId(itemId);
    setEmployeePickScanError("");
    setEmployeeFlowWarning("");
    try {
      const data = await fetchJson(
        `${API_BASE}/employee/assemblies/${encodeURIComponent(employeeSelectedAssembly.id)}/pick-items/${itemId}/collect-without-scan`,
        {
          method: "POST",
        }
      );
      suppressEmployeeLiveRefresh();
      if (data?.item?.id) {
        rememberEmployeePickScroll(data.item.id);
        setEmployeePickItems((prev) => mergeEmployeePickItem(prev, data.item));
        restoreEmployeePickScroll();
      }
      if (data?.session) {
        setEmployeeAssemblySession((prev) => (prev ? { ...prev, session: data.session } : prev));
        setEmployeeSelectedAssembly((prev) =>
          prev && prev.id === employeeSelectedAssembly.id ? { ...prev, session: data.session } : prev
        );
      }
      setEmployeeFlowNotice(
        data?.completed
          ? "Все товары собраны. Нажмите «Завершить сборку товара»."
          : "Товар собран без штрихкода по разрешению администратора."
      );
    } catch (err) {
      if (handleAuthError(err)) return;
      setEmployeePickScanError(err?.message || "Не удалось собрать товар без штрихкода");
    } finally {
      setEmployeePickManualBusyId(null);
    }
  };

  const openEditUser = (user) => {
    setEditUser(user);
    setEditRole(user?.role || "employee");
    setUserActionError("");
  };

  const handleCreateUser = async () => {
    setUserActionError("");
    const externalUserId = Number(createExternalUserId);
    if (!Number.isFinite(externalUserId) || externalUserId < 1) {
      setUserActionError("Выберите сотрудника из общей базы");
      return;
    }
    setUserBusy(true);
    try {
      await fetchJson(`${API_BASE}/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          externalUserId,
          role: usersRoleFilter,
        }),
      });
      setCreateExternalUserId("");
      await Promise.all([loadUsers(), loadUserDirectory()]);
    } catch (err) {
      if (handleAuthError(err)) return;
      setUserActionError(err?.message || "Не удалось создать пользователя");
    } finally {
      setUserBusy(false);
    }
  };

  const handleSaveUser = async () => {
    if (!editUser) return;
    setUserActionError("");
    if (!["admin", "employee"].includes(editRole)) {
      setUserActionError("Некорректная роль");
      return;
    }
    setUserBusy(true);
    try {
      await fetchJson(`${API_BASE}/users/${editUser.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: editRole }),
      });
      setEditUser(null);
      await Promise.all([loadUsers(), loadUserDirectory()]);
    } catch (err) {
      if (handleAuthError(err)) return;
      setUserActionError(err?.message || "Не удалось сохранить");
    } finally {
      setUserBusy(false);
    }
  };

  const handleDeleteUser = async (user) => {
    if (!user) return;
    if (!window.confirm(`Удалить ${user.fullName || `${user.surname} ${user.name}`.trim() || user.login}?`)) return;
    setUserBusy(true);
    setUserActionError("");
    try {
      await fetchJson(`${API_BASE}/users/${user.id}`, { method: "DELETE" });
      await Promise.all([loadUsers(), loadUserDirectory()]);
    } catch (err) {
      if (handleAuthError(err)) return;
      setUserActionError(err?.message || "Не удалось удалить");
    } finally {
      setUserBusy(false);
    }
  };

  const newItems = useMemo(() => {
    const map = new Map();
    for (const order of newOrders) {
      for (const product of order.products || []) {
        const article = String(product.offerId || "").trim();
        if (!article) continue;
        const key = `${article}::${product.name || ""}`;
        if (!map.has(key)) {
          map.set(key, {
            article,
            name: product.name || "",
            sku: Number.isFinite(Number(product.sku)) ? Number(product.sku) : null,
            count: 0,
          });
        }
        map.get(key).count += Number(product.quantity || 0);
      }
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [newOrders]);

  const articleOptions = useMemo(() => {
    const map = new Map();
    for (const item of newItems) {
      if (!map.has(item.article)) {
        map.set(item.article, { article: item.article, name: item.name });
      }
    }
    return Array.from(map.values());
  }, [newItems]);

  const safeCreateCount = Math.max(1, Number(createCount) || 1);
  const selectionByCount = useMemo(
    () => pickOrdersByCount(newOrders, createSort, safeCreateCount),
    [newOrders, createSort, safeCreateCount]
  );

  const articleSelection = useMemo(
    () => buildArticleSelection(articleRows, newOrders),
    [articleRows, newOrders]
  );

  const selectedForCreate = createMode === "count" ? selectionByCount : articleSelection.selected;
  const assemblyItems = useMemo(() => aggregateAssemblyItems(assemblyOrders), [assemblyOrders]);
  const readyToShipOrders = useMemo(
    () => assemblyOrders.filter((order) => order.collectedAt && !order.sentToDeliveringAt),
    [assemblyOrders]
  );
  const assemblyShipment = assemblySettings?.shipment || null;
  const shipmentPostingNumbers = useMemo(() => {
    if (Array.isArray(assemblyShipment?.postingNumbers) && assemblyShipment.postingNumbers.length) {
      return assemblyShipment.postingNumbers;
    }
    return readyToShipOrders.map((order) => order.postingNumber);
  }, [assemblyShipment, readyToShipOrders]);
  const shipmentDocs = assemblyShipment?.docs || null;
  const shipmentBarcodeUrl = shipmentDocs?.actBarcodeUrl || "";
  const isAssemblyCompleted = (assembly) => {
    const total = Number(assembly?.orderCount || 0);
    const collected = Number(assembly?.collectedCount || 0);
    const sent = Number(assembly?.sentCount || 0);
    if (total === 0) return sent > 0;
    return collected >= total;
  };
  const isSelectedAssemblyCompleted = Number(assemblyTotals.total || 0) > 0 && Number(assemblyTotals.remaining || 0) === 0;

  const handleCreateAssembly = async () => {
    if (!storeId) {
      setCreateError("Выберите магазин");
      return;
    }
    setCreateError("");
    if (!selectedForCreate.length) {
      setCreateError("Нет выбранных заказов");
      return;
    }
    setCreateBusy(true);
    try {
      const data = await adminFetch(`${API_BASE}/assemblies/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          postingNumbers: selectedForCreate.map((order) => order.postingNumber),
        }),
      });
      setCreateBusy(false);
      setCreateOpen(false);
      setCreateError("");
      await loadNewOrders({ silent: true });
      await loadAssemblies({ silent: true });
      if (data?.assemblyId) {
        const assembly = {
          id: data.assemblyId,
          name: data.assemblyName || "Сборка Ozon",
        };
        setSelectedAssembly(assembly);
        setShipmentError("");
        setShipmentNotice("");
        loadAssemblyOrders(assembly.id);
        loadAssemblySettings(assembly.id);
        loadAssemblyLabelDiagnostics(assembly.id);
      }
    } catch (err) {
      if (handleAuthError(err)) return;
      setCreateError(err?.message || "Не удалось создать сборку");
      setCreateBusy(false);
    }
  };

  const openAssembly = (assembly) => {
    setSelectedAssembly(assembly);
    setAssemblyTab("orders");
    setAssemblySettingsNotice("");
    setAssemblyLabelDiagnostics(null);
    setAssemblyLabelDiagnosticsError("");
    setAssemblyEmployeeQuery("");
    setAssemblyAccessDirty(false);
    setShipmentError("");
    setShipmentNotice("");
    loadAssemblyOrders(assembly.id);
    loadAssemblySettings(assembly.id);
    loadAssemblyLabelDiagnostics(assembly.id);
  };

  const handleAccessModeChange = async (mode) => {
    if (!selectedAssembly || mode === accessMode) return;
    setAccessMode(mode);
    setAssemblyAccessDirty(false);
    setSettingsBusy(true);
    setAssemblySettingsError("");
    setAssemblySettingsNotice("");
    try {
      await adminFetch(`${API_BASE}/assemblies/${encodeURIComponent(selectedAssembly.id)}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessMode: mode }),
      });
      await Promise.all([
        loadAssemblySettings(selectedAssembly.id, { silent: true, preserveEditorState: false }),
        loadAssemblyOrders(selectedAssembly.id, { silent: true }),
        loadAssemblies({ silent: true }),
      ]);
      setAssemblySettingsNotice(mode === "hidden" ? "Сборка скрыта" : "Режим доступа обновлён");
    } catch (err) {
      if (handleAuthError(err)) return;
      setAssemblySettingsError(err?.message || "Не удалось сохранить режим доступа");
      setAssemblyAccessDirty(true);
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleEmployeeWorkflowModeChange = async (enabled) => {
    if (!selectedAssembly) return;
    const nextMode = enabled ? "picking" : "legacy";
    setSettingsBusy(true);
    setAssemblySettingsError("");
    setAssemblySettingsNotice("");
    try {
      await adminFetch(`${API_BASE}/assemblies/${encodeURIComponent(selectedAssembly.id)}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeWorkflowMode: nextMode }),
      });
      await Promise.all([
        loadAssemblySettings(selectedAssembly.id, { silent: true, preserveEditorState: false }),
        loadAssemblyOrders(selectedAssembly.id, { silent: true }),
        loadAssemblies({ silent: true }),
      ]);
      setAssemblySettingsNotice(
        nextMode === "picking"
          ? "Включён новый метод: сначала сборка товара, потом упаковка заказов."
          : "Включён старый метод: сотрудники сразу переходят к упаковке заказов."
      );
    } catch (err) {
      if (handleAuthError(err)) return;
      setAssemblySettingsError(err?.message || "Не удалось переключить метод сборки");
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleStockMethodChange = async (enabled) => {
    if (!selectedAssembly) return;
    setSettingsBusy(true);
    setAssemblySettingsError("");
    setAssemblySettingsNotice("");
    try {
      await adminFetch(`${API_BASE}/assemblies/${encodeURIComponent(selectedAssembly.id)}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stockMethodEnabled: enabled }),
      });
      await Promise.all([
        loadAssemblySettings(selectedAssembly.id, { silent: true, preserveEditorState: false }),
        loadAssemblyOrders(selectedAssembly.id, { silent: true }),
        loadAssemblies({ silent: true }),
      ]);
      setAssemblySettingsNotice(
        enabled
          ? "Включён новый складской метод: при сканировании идут автоперемещение и списание."
          : "Включён старый складской метод: сборка идёт без работы с остатками."
      );
    } catch (err) {
      if (handleAuthError(err)) return;
      setAssemblySettingsError(err?.message || "Не удалось переключить складской метод");
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleStartProductPicking = async () => {
    if (!selectedAssembly) return;
    setSettingsBusy(true);
    setAssemblySettingsError("");
    setAssemblySettingsNotice("");
    try {
      await adminFetch(`${API_BASE}/assemblies/${encodeURIComponent(selectedAssembly.id)}/product-picking/start`, {
        method: "POST",
      });
      await Promise.all([
        loadAssemblySettings(selectedAssembly.id, { silent: true, preserveEditorState: false }),
        loadAssemblyOrders(selectedAssembly.id, { silent: true }),
        loadAssemblies({ silent: true }),
      ]);
      setAssemblySettingsNotice("Сборка товара для упаковщиков запущена.");
    } catch (err) {
      if (handleAuthError(err)) return;
      setAssemblySettingsError(err?.message || "Не удалось запустить сборку товара");
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleSaveAccessUsers = async () => {
    if (!selectedAssembly) return;
    setSettingsBusy(true);
    setAssemblySettingsError("");
    setAssemblySettingsNotice("");
    try {
      await adminFetch(`${API_BASE}/assemblies/${encodeURIComponent(selectedAssembly.id)}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: accessUsers }),
      });
      setAssemblyAccessDirty(false);
      await Promise.all([
        loadAssemblySettings(selectedAssembly.id, { silent: true, preserveEditorState: false }),
        loadAssemblies({ silent: true }),
      ]);
      setAssemblySettingsNotice("Доступ сотрудников обновлён");
    } catch (err) {
      if (handleAuthError(err)) return;
      setAssemblySettingsError(err?.message || "Не удалось обновить доступ сотрудников");
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleSplitAssembly = async (mode) => {
    if (!selectedAssembly) return;
    setSettingsBusy(true);
    setAssemblySettingsError("");
    setAssemblySettingsNotice("");
    try {
      const path = mode === "redistribute" ? "redistribute" : "split";
      await adminFetch(`${API_BASE}/assemblies/${encodeURIComponent(selectedAssembly.id)}/${path}`, {
        method: "POST",
      });
      setAssemblyAccessDirty(false);
      await Promise.all([
        loadAssemblySettings(selectedAssembly.id, { silent: true, preserveEditorState: false }),
        loadAssemblyOrders(selectedAssembly.id, { silent: true }),
        loadAssemblyLabelDiagnostics(selectedAssembly.id, { silent: true }),
        loadAssemblies({ silent: true }),
      ]);
      setAssemblySettingsNotice(mode === "redistribute" ? "Заказы перераспределены" : "Заказы распределены");
    } catch (err) {
      if (handleAuthError(err)) return;
      setAssemblySettingsError(err?.message || "Не удалось выполнить распределение");
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleHideAssembly = async () => {
    if (!selectedAssembly) return;
    setSettingsBusy(true);
    setAssemblySettingsError("");
    setAssemblySettingsNotice("");
    try {
      await adminFetch(`${API_BASE}/assemblies/${encodeURIComponent(selectedAssembly.id)}/reset-access`, {
        method: "POST",
      });
      setAssemblyAccessDirty(false);
      await Promise.all([
        loadAssemblySettings(selectedAssembly.id, { silent: true, preserveEditorState: false }),
        loadAssemblyOrders(selectedAssembly.id, { silent: true }),
        loadAssemblies({ silent: true }),
      ]);
      setAssemblySettingsNotice("Сборка скрыта");
    } catch (err) {
      if (handleAuthError(err)) return;
      setAssemblySettingsError(err?.message || "Не удалось скрыть сборку");
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleRefreshLabels = async ({ force = false } = {}) => {
    if (!selectedAssembly) return;
    setSettingsBusy(true);
    setAssemblySettingsError("");
    setAssemblySettingsNotice("");
    setAssemblyLabelDiagnosticsError("");
    try {
      await adminFetch(`${API_BASE}/assemblies/${encodeURIComponent(selectedAssembly.id)}/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      setAssemblySettingsNotice(force ? "Форс-перезагрузка этикеток запущена" : "Повторная загрузка этикеток запущена");
      await Promise.all([
        loadAssemblySettings(selectedAssembly.id, {
          silent: true,
          preserveEditorState: selectedAssemblyTabRef.current === "settings" && (assemblyAccessDirty || settingsBusy),
        }),
        loadAssemblyOrders(selectedAssembly.id, { silent: true }),
        loadAssemblyLabelDiagnostics(selectedAssembly.id, { silent: true }),
        loadAssemblies({ silent: true }),
      ]);
    } catch (err) {
      if (handleAuthError(err)) return;
      setAssemblySettingsError(err?.message || "Не удалось запустить обновление этикеток");
    } finally {
      setSettingsBusy(false);
    }
  };

  const handlePrepareShipment = async () => {
    if (!selectedAssembly) return;
    setShipmentBusy(true);
    setShipmentError("");
    setShipmentNotice("");
    try {
      await adminFetch(`${API_BASE}/assemblies/${encodeURIComponent(selectedAssembly.id)}/shipment/prepare`, {
        method: "POST",
      });
      await Promise.all([
        loadAssemblySettings(selectedAssembly.id, { silent: true }),
        loadAssemblyOrders(selectedAssembly.id, { silent: true }),
        loadAssemblies({ silent: true }),
      ]);
      setShipmentNotice("Поставка сформирована. Этикетка готова к печати.");
    } catch (err) {
      if (handleAuthError(err)) return;
      setShipmentError(err?.message || "Не удалось сформировать поставку");
    } finally {
      setShipmentBusy(false);
    }
  };

  const handleConfirmShipment = async () => {
    if (!selectedAssembly) return;
    setShipmentBusy(true);
    setShipmentError("");
    setShipmentNotice("");
    try {
      const data = await adminFetch(`${API_BASE}/assemblies/${encodeURIComponent(selectedAssembly.id)}/shipment/confirm`, {
        method: "POST",
      });
      await Promise.all([
        loadAssemblyOrders(selectedAssembly.id, { silent: true }),
        loadAssemblies({ silent: true }),
        loadAssemblySettings(selectedAssembly.id, { silent: true }),
      ]);
      setShipmentNotice(
        `Отгрузка подтверждена: отправлено ${Number(data?.sentCount || 0)}, ошибок ${Number(data?.failedCount || 0)}`
      );
    } catch (err) {
      if (handleAuthError(err)) return;
      setShipmentError(err?.message || "Не удалось подтвердить отгрузку");
    } finally {
      setShipmentBusy(false);
    }
  };

  const handleReloadLabelDiagnostics = async () => {
    if (!selectedAssembly) return;
    setAssemblySettingsError("");
    setAssemblySettingsNotice("");
    const diagnostics = await loadAssemblyLabelDiagnostics(selectedAssembly.id);
    if (diagnostics) {
      setAssemblySettingsNotice(
        `Диагностика обновлена: ошибок ${diagnostics.failedCount || 0}, не загружено ${diagnostics.pendingCount || 0}`
      );
    }
  };

  const handleExportAssemblyItems = async () => {
    if (!selectedAssembly || !assemblyItems.length) return;
    try {
      const XLSX = await import("xlsx");
      const rows = assemblyItems.map((item) => ({
        "Артикул продавца": item.article || "",
        "Название": item.name || "",
        "Штрихкод Ozon": item.marketplaceBarcode || "",
        "Кол-во": item.count || 0,
      }));
      const header = ["Артикул продавца", "Название", "Штрихкод Ozon", "Кол-во"];
      const sheet = XLSX.utils.json_to_sheet(rows, { header });
      sheet["!cols"] = [{ wch: 24 }, { wch: 48 }, { wch: 22 }, { wch: 10 }];
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, "Товары");
      const data = XLSX.write(book, { bookType: "xlsx", type: "array" });
      const blob = new Blob([data], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `assembly_${selectedAssembly.id}_items.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Excel export failed", err);
    }
  };

  const handleExportAssemblyEmployeeItems = async (employee) => {
    if (!selectedAssembly || !employee?.id) return;
    setAssemblySettingsNotice("");
    setAssemblySettingsError("");
    let orders = assemblyOrders;
    if (!orders.length) {
      orders = await loadAssemblyOrders(selectedAssembly.id, { silent: true });
    }
    const assignedOrders = (Array.isArray(orders) ? orders : []).filter(
      (order) => Number(order?.assignedUserId || 0) === Number(employee.id)
    );
    const items = aggregateAssemblyItems(assignedOrders);
    if (!items.length) {
      setAssemblySettingsNotice(`Для сотрудника ${employee.surname || ""} ${employee.name || ""} нет назначенных товаров.`);
      return;
    }
    const totalCount = items.reduce((sum, item) => sum + Number(item.count || 0), 0);
    try {
      const XLSX = await import("xlsx");
      const rows = items.map((item) => ({
        "Артикул продавца": item.article || "",
        "Название": item.name || "",
        "Штрихкод Ozon": item.marketplaceBarcode || "",
        "Кол-во": item.count || 0,
      }));
      const header = ["Артикул продавца", "Название", "Штрихкод Ozon", "Кол-во"];
      const sheet = XLSX.utils.json_to_sheet(rows, { header });
      sheet["!cols"] = [{ wch: 24 }, { wch: 48 }, { wch: 22 }, { wch: 10 }];
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, "Товары");
      const data = XLSX.write(book, { bookType: "xlsx", type: "array" });
      const blob = new Blob([data], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const fileSurname = sanitizeFilePart(employee.surname || `employee_${employee.id}`, `employee_${employee.id}`);
      link.download = `${fileSurname}_${totalCount}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Excel export failed", err);
    }
  };

  const handleOpenEmployeeAssembly = (assembly) => {
    setEmployeeSelectedAssembly(assembly);
    setEmployeeSelectedOrder(null);
    setEmployeeAssemblySession(null);
    setEmployeeAssemblySessionError("");
    setEmployeeStartError("");
    setEmployeeFlowNotice("");
    setEmployeeFlowWarning("");
    setEmployeePickItems([]);
    setEmployeePickItemsError("");
    setEmployeePickScanValue("");
    setEmployeePickScanError("");
    setEmployeePickFinishError("");
    setEmployeePickIssueOpen(false);
    setEmployeePickIssueValue("");
    setEmployeePickIssueItemId("");
    setEmployeePickIssueError("");
    setEmployeeLookupValue("");
    setEmployeeLookupError("");
    setEmployeeIssueOpen(false);
    setEmployeeIssueValue("");
    setEmployeeIssueError("");
    setEmployeeIssueLineNos([]);
    setScanValue("");
    setLabelScanValue("");
    setScanError("");
    setLabelScanError("");
    loadEmployeeAssemblySession(assembly.id);
  };

  const submitProductScan = async (value = scanValue) => {
    if (!employeeSelectedAssembly || !employeeSelectedOrder) return;
    if (!employeeAssemblySession?.canWork) return;
    if (scanTimerRef.current) {
      clearTimeout(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    if (scanBusy) return;
    const barcode = String(value || "").trim();
    if (!barcode) return;
    setScanBusy(true);
    setScanError("");
    setEmployeeFlowNotice("");
    try {
      const data = await fetchJson(
        `${API_BASE}/employee/assemblies/${encodeURIComponent(employeeSelectedAssembly.id)}/orders/${encodeURIComponent(
          employeeSelectedOrder.postingNumber
        )}/scan`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ barcode }),
        }
      );
      setScanValue("");
      if (data?.order) {
        upsertEmployeeOrderState(data.order);
      }
    } catch (err) {
      if (handleAuthError(err)) return;
      setScanError(err?.message || "Отсканируйте повторно");
      setScanValue("");
      if (scanInputRef.current) scanInputRef.current.focus();
    } finally {
      setScanBusy(false);
    }
  };

  const submitLabelScan = async (value = labelScanValue) => {
    if (!employeeSelectedAssembly || !employeeSelectedOrder) return;
    if (!employeeAssemblySession?.canWork) return;
    if (labelScanTimerRef.current) {
      clearTimeout(labelScanTimerRef.current);
      labelScanTimerRef.current = null;
    }
    if (labelScanBusy) return;
    const barcode = String(value || "").trim();
    if (!barcode) return;
    setLabelScanBusy(true);
    setLabelScanError("");
    setEmployeeFlowNotice("");
    try {
      const data = await fetchJson(
        `${API_BASE}/employee/assemblies/${encodeURIComponent(employeeSelectedAssembly.id)}/orders/${encodeURIComponent(
          employeeSelectedOrder.postingNumber
        )}/label-scan`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ barcode }),
        }
      );
      setLabelScanValue("");
      removeEmployeeOrderState(employeeSelectedOrder.postingNumber);
      const orders = await loadEmployeeOrders(employeeSelectedAssembly.id, { silent: true });
      let sessionData = employeeAssemblySession;
      if (data?.sessionFinished) {
        sessionData = await loadEmployeeAssemblySession(employeeSelectedAssembly.id, { silent: true });
      }
      if (data?.sessionFinished || sessionData?.canWork === false) {
        setEmployeeFlowNotice("Сборка завершена. Заказы закрыты автоматически.");
        setEmployeeSelectedOrder(null);
      } else {
        const nextOrder = Array.isArray(orders)
          ? orders.find((item) => item.postingNumber !== employeeSelectedOrder.postingNumber) || null
          : null;
        if (nextOrder) {
          setEmployeeSelectedOrder(nextOrder);
          setEmployeeFlowNotice("Заказ собран. Открыт следующий заказ.");
        } else {
          setEmployeeSelectedOrder(null);
          setEmployeeFlowNotice("Заказ собран. Можно сканировать следующий товар.");
        }
      }
    } catch (err) {
      if (handleAuthError(err)) return;
      setLabelScanError(err?.message || "Отсканируйте повторно");
      setLabelScanValue("");
      if (labelScanInputRef.current) labelScanInputRef.current.focus();
    } finally {
      setLabelScanBusy(false);
    }
  };

  useEffect(() => {
    if (scanTimerRef.current) {
      clearTimeout(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    if (employeeLookupTimerRef.current) {
      clearTimeout(employeeLookupTimerRef.current);
      employeeLookupTimerRef.current = null;
    }
    if (labelScanTimerRef.current) {
      clearTimeout(labelScanTimerRef.current);
      labelScanTimerRef.current = null;
    }
    if (employeePickScanTimerRef.current) {
      clearTimeout(employeePickScanTimerRef.current);
      employeePickScanTimerRef.current = null;
    }
    if (employeePickIssueTimerRef.current) {
      clearTimeout(employeePickIssueTimerRef.current);
      employeePickIssueTimerRef.current = null;
    }
    setEmployeeIssueOpen(false);
    setEmployeeIssueValue("");
    setEmployeeIssueError("");
    setEmployeeIssueLineNos([]);
    setEmployeePickIssueOpen(false);
    setEmployeePickIssueValue("");
    setEmployeePickIssueItemId("");
    setEmployeePickIssueError("");
    setScanValue("");
    setScanError("");
    setScanBusy(false);
    setLabelScanValue("");
    setLabelScanError("");
    setLabelScanBusy(false);
  }, [employeeSelectedOrder?.postingNumber]);

  useEffect(() => {
    if (!employeeSelectedOrder) return;
    if (!employeeSelectedOrder.scanDone && scanInputRef.current) {
      scanInputRef.current.focus();
    }
    if (employeeSelectedOrder.scanDone && !employeeSelectedOrder.labelScanPassedAt && labelScanInputRef.current) {
      labelScanInputRef.current.focus();
    }
  }, [employeeSelectedOrder]);

  useEffect(() => {
    if (employeeIssueOpen && employeeIssueInputRef.current) {
      employeeIssueInputRef.current.focus();
    }
  }, [employeeIssueOpen]);

  useEffect(() => {
    if (!canKeepEmployeePickScanFocus) return;
    if (employeePickScanBusy) return;
    queueEmployeePickScanFocus();
  }, [canKeepEmployeePickScanFocus, employeePickScanBusy]);

  useEffect(() => {
    if (employeeSelectedAssembly && !employeeSelectedOrder && employeeAssemblySession?.canWork && employeeLookupInputRef.current) {
      employeeLookupInputRef.current.focus();
    }
  }, [employeeSelectedAssembly, employeeSelectedOrder, employeeAssemblySession?.canWork]);

  useEffect(() => {
    if (!employeeSelectedAssembly || !employeeAssemblySession?.canWork) return;
    if (employeeAssemblySession?.workflow?.currentStage === "picking") return;
    loadEmployeeOrders(employeeSelectedAssembly.id, { silent: true });
  }, [employeeSelectedAssembly?.id, employeeAssemblySession?.canWork, employeeAssemblySession?.workflow?.currentStage]);

  useEffect(() => {
    if (!employeeSelectedOrder) return;
    const openLineNos = Array.isArray(employeeSelectedOrder.items)
      ? employeeSelectedOrder.items
          .filter((item) => Number(item.scannedQty || 0) < Number(item.quantity || 0))
          .map((item) => Number(item.lineNo))
      : [];
    setEmployeeIssueLineNos(openLineNos);
  }, [employeeSelectedOrder?.postingNumber]);

  useEffect(() => {
    if (!employeeSelectedAssembly || employeeSelectedOrder || !employeeAssemblySession?.canWork) return;
    const value = employeeLookupValue.trim();
    if (!value || employeeLookupBusy) return;
    if (employeeLookupTimerRef.current) clearTimeout(employeeLookupTimerRef.current);
    employeeLookupTimerRef.current = setTimeout(() => {
      employeeLookupTimerRef.current = null;
      handleEmployeeLookupScan(value);
    }, 200);
  }, [
    employeeLookupValue,
    employeeLookupBusy,
    employeeSelectedAssembly,
    employeeSelectedOrder?.postingNumber,
    employeeAssemblySession?.canWork,
  ]);

  useEffect(() => {
    if (!employeeSelectedAssembly) return;
    const currentStage = employeeAssemblySession?.workflow?.currentStage || "";
    if (currentStage !== "picking") return;
    const value = employeePickScanValue.trim();
    if (!value || employeePickScanBusy) return;
    if (employeePickScanTimerRef.current) clearTimeout(employeePickScanTimerRef.current);
    employeePickScanTimerRef.current = setTimeout(() => {
      employeePickScanTimerRef.current = null;
      handleEmployeePickScan(value);
    }, 200);
  }, [
    employeePickScanValue,
    employeePickScanBusy,
    employeeSelectedAssembly?.id,
    employeeAssemblySession?.workflow?.currentStage,
  ]);

  useEffect(() => {
    if (!employeeSelectedAssembly) return;
    const currentStage = employeeAssemblySession?.workflow?.currentStage || "";
    if (currentStage !== "picking") {
      setEmployeePickItems([]);
      return;
    }
    loadEmployeePickItems(employeeSelectedAssembly.id, { silent: true });
    setEmployeeOrders([]);
    setEmployeeSelectedOrder(null);
  }, [employeeSelectedAssembly?.id, employeeAssemblySession?.workflow?.currentStage]);

  useEffect(() => {
    if (!employeePickIssueOpen || employeeAssemblySession?.workflow?.currentStage !== "picking") return;
    setTimeout(() => {
      if (employeePickIssueInputRef.current) {
        employeePickIssueInputRef.current.focus();
      }
    }, 50);
  }, [employeePickIssueOpen, employeeAssemblySession?.workflow?.currentStage]);

  useEffect(() => {
    if (!employeePickIssueOpen || employeeAssemblySession?.workflow?.currentStage !== "picking") return;
    const value = employeePickIssueValue.trim();
    if (!value || !employeePickIssueItemId) return;
    if (employeePickIssueTimerRef.current) clearTimeout(employeePickIssueTimerRef.current);
    employeePickIssueTimerRef.current = setTimeout(() => {
      employeePickIssueTimerRef.current = null;
      handleEmployeePickIssueSubmit(value);
    }, 200);
  }, [
    employeePickIssueValue,
    employeePickIssueOpen,
    employeePickIssueItemId,
    employeeAssemblySession?.workflow?.currentStage,
  ]);

  useEffect(() => {
    if (!employeePickIssueOpen) return;
    const firstPending = employeePickItems.find((item) => Number(item?.remainingQty || 0) > 0);
    if (!firstPending) return;
    const currentId = Number(employeePickIssueItemId);
    const exists = employeePickItems.some(
      (item) => Number(item.id) === currentId && Number(item?.remainingQty || 0) > 0
    );
    if (exists) return;
    setEmployeePickIssueItemId(String(firstPending.id));
  }, [employeePickIssueOpen, employeePickIssueItemId, employeePickItems]);

  useEffect(() => {
    employeePickFocusGuardRef.current = { canFocus: Boolean(canKeepEmployeePickScanFocus) };
  }, [canKeepEmployeePickScanFocus]);

  useEffect(() => {
    restoreEmployeePickScroll();
  }, [employeePickItems]);

  useEffect(() => {
    if (!employeeSelectedAssembly || !employeeSelectedOrder || employeeSelectedOrder.scanDone) return;
    const value = scanValue.trim();
    if (!value || scanBusy) return;
    if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    scanTimerRef.current = setTimeout(() => {
      scanTimerRef.current = null;
      submitProductScan(value);
    }, 200);
  }, [scanValue, scanBusy, employeeSelectedAssembly, employeeSelectedOrder?.postingNumber, employeeSelectedOrder?.scanDone]);

  useEffect(() => {
    if (!employeeSelectedAssembly || !employeeSelectedOrder) return;
    if (!employeeSelectedOrder.scanDone || employeeSelectedOrder.labelScanPassedAt) return;
    const value = labelScanValue.trim();
    if (!value || labelScanBusy) return;
    if (labelScanTimerRef.current) clearTimeout(labelScanTimerRef.current);
    labelScanTimerRef.current = setTimeout(() => {
      labelScanTimerRef.current = null;
      submitLabelScan(value);
    }, 200);
  }, [
    labelScanValue,
    labelScanBusy,
    employeeSelectedAssembly,
    employeeSelectedOrder?.postingNumber,
    employeeSelectedOrder?.scanDone,
    employeeSelectedOrder?.labelScanPassedAt,
  ]);

  useEffect(() => {
    return () => {
      if (employeeLookupTimerRef.current) {
        clearTimeout(employeeLookupTimerRef.current);
        employeeLookupTimerRef.current = null;
      }
      if (scanTimerRef.current) {
        clearTimeout(scanTimerRef.current);
        scanTimerRef.current = null;
      }
      if (labelScanTimerRef.current) {
        clearTimeout(labelScanTimerRef.current);
        labelScanTimerRef.current = null;
      }
      if (employeePickScanTimerRef.current) {
        clearTimeout(employeePickScanTimerRef.current);
        employeePickScanTimerRef.current = null;
      }
      if (employeePickIssueTimerRef.current) {
        clearTimeout(employeePickIssueTimerRef.current);
        employeePickIssueTimerRef.current = null;
      }
    };
  }, []);

  const filteredAssemblyEmployees = useMemo(() => {
    const query = assemblyEmployeeQuery.trim().toLowerCase();
    if (!query) return assemblyEmployees;
    return assemblyEmployees.filter((emp) => {
      const fullName = `${emp.surname || ""} ${emp.name || ""}`.toLowerCase();
      return fullName.includes(query);
    });
  }, [assemblyEmployees, assemblyEmployeeQuery]);

  useEffect(() => {
    selectedAssemblyRef.current = selectedAssembly;
  }, [selectedAssembly]);

  useEffect(() => {
    selectedAssemblyTabRef.current = assemblyTab;
  }, [assemblyTab]);

  useEffect(() => {
    employeeSelectedAssemblyRef.current = employeeSelectedAssembly;
  }, [employeeSelectedAssembly]);

  useEffect(() => {
    employeeSelectedOrderRef.current = employeeSelectedOrder;
  }, [employeeSelectedOrder]);

  useEffect(() => {
    if (!employeeStatsUser) return;
    if (employeeStatsRangeKey === "custom" && (!employeeStatsCustomFrom || !employeeStatsCustomTo)) return;
    loadEmployeeStats(employeeStatsUser, {
      rangeKey: employeeStatsRangeKey,
      customFrom: employeeStatsCustomFrom,
      customTo: employeeStatsCustomTo,
    });
  }, [employeeStatsUser, employeeStatsRangeKey]);

  const newOrdersCount = newOrders.length;
  const assemblyOrdersCount = assemblies.reduce((sum, assembly) => {
    const orderCount = Number(assembly?.orderCount || 0);
    return sum + Math.max(0, orderCount);
  }, 0);
  const openIssuesCount = scanIssues.length;
  const fbsStockAlertCount = Number(fbsStockTotals.shortage || 0) + Number(fbsStockTotals.errors || 0);
  const stockMethodEnabled = assemblySettings?.stockMethodEnabled === true;
  const stockProblemsAlertCount =
    Number(stockProblems.negativeShelves?.length || 0) +
    Number(stockProblems.negativeEmployees?.length || 0) +
    Number(stockProblems.leftoverEmployees?.length || 0);
  const visibleFbsStockStores = useMemo(() => {
    const source = Array.isArray(fbsStockScopeStores) && fbsStockScopeStores.length
      ? fbsStockScopeStores
      : storeOptions;
    return (Array.isArray(source) ? source : [])
      .map((store) => ({
        id: String(store?.id || "").trim(),
        name: String(store?.name || store?.id || "").trim(),
      }))
      .filter((store) => store.id);
  }, [fbsStockScopeStores, storeOptions]);
  const fbsStockGridTemplate = useMemo(() => {
    const storeColumns = visibleFbsStockStores.map(() => "minmax(120px, 0.55fr)");
    return [
      "minmax(220px, 1.3fr)",
      "minmax(150px, 0.8fr)",
      "minmax(170px, 0.8fr)",
      ...storeColumns,
      "minmax(110px, 0.55fr)",
      "minmax(110px, 0.55fr)",
      "minmax(120px, 0.7fr)",
      "minmax(320px, 1.6fr)",
    ].join(" ");
  }, [visibleFbsStockStores]);
  const hasAssignments = assemblyProgress.some((item) => Number(item.total || 0) > 0);
  const employeeWorkflowMode = assemblySettings?.employeeWorkflowMode || "legacy";
  const employeeWorkflowIsPicking = employeeWorkflowMode === "picking";
  const employeeWorkflowStage = assemblySettings?.employeeWorkflowStage || "orders_only";

  if (!authChecked) {
    return <div className="app"><div className="login-card">Проверка авторизации...</div></div>;
  }

  if (!currentUser) {
    return (
      <LoginView
        surname={loginSurname}
        setSurname={setLoginSurname}
        password={loginPassword}
        setPassword={setLoginPassword}
        error={loginError}
        busy={loginBusy}
        onLogin={handleLogin}
      />
    );
  }

  if (isEmployee) {
    if (isCollectorEmployee) {
      return (
        <CollectorView
          currentUser={currentUser}
          handleLogout={handleLogout}
          apiBase={API_BASE}
          employeePositionLabel={employeePositionLabel}
        />
      );
    }
    return (
      <EmployeeView
        currentUser={currentUser}
        handleLogout={handleLogout}
        employeeAssembliesError={employeeAssembliesError}
        employeeAssembliesLoading={employeeAssembliesLoading}
        employeeAssemblies={employeeAssemblies}
        employeeSelectedAssembly={employeeSelectedAssembly}
        setEmployeeSelectedAssembly={setEmployeeSelectedAssembly}
        openEmployeeAssembly={handleOpenEmployeeAssembly}
        employeeSelectedOrder={employeeSelectedOrder}
        setEmployeeSelectedOrder={setEmployeeSelectedOrder}
        employeeAssemblySession={employeeAssemblySession}
        employeeAssemblySessionLoading={employeeAssemblySessionLoading}
        employeeAssemblySessionError={employeeAssemblySessionError}
        employeeStartBusy={employeeStartBusy}
        employeeStartError={employeeStartError}
        employeeFlowNotice={employeeFlowNotice}
        employeeFlowWarning={employeeFlowWarning}
        employeePickItems={employeePickItems}
        employeePickItemsLoading={employeePickItemsLoading}
        employeePickItemsError={employeePickItemsError}
        employeePickListBodyRef={employeePickListBodyRef}
        employeePickScanInputRef={employeePickScanInputRef}
        handleEmployeePickScanInputBlur={handleEmployeePickScanInputBlur}
        employeePickScanValue={employeePickScanValue}
        setEmployeePickScanValue={setEmployeePickScanValue}
        employeePickScanBusy={employeePickScanBusy}
        employeePickScanError={employeePickScanError}
        employeePickFinishBusy={employeePickFinishBusy}
        employeePickFinishError={employeePickFinishError}
        employeePickIssueOpen={employeePickIssueOpen}
        setEmployeePickIssueOpen={setEmployeePickIssueOpen}
        employeePickIssueInputRef={employeePickIssueInputRef}
        employeePickIssueValue={employeePickIssueValue}
        setEmployeePickIssueValue={setEmployeePickIssueValue}
        employeePickIssueItemId={employeePickIssueItemId}
        setEmployeePickIssueItemId={setEmployeePickIssueItemId}
        employeePickIssueBusy={employeePickIssueBusy}
        employeePickIssueError={employeePickIssueError}
        setEmployeePickIssueError={setEmployeePickIssueError}
        employeePickManualBusyId={employeePickManualBusyId}
        handleEmployeePickCollectWithoutScan={handleEmployeePickCollectWithoutScan}
        handleEmployeePickIssueSubmit={handleEmployeePickIssueSubmit}
        handleEmployeePickFinish={handleEmployeePickFinish}
        employeeLookupInputRef={employeeLookupInputRef}
        employeeLookupValue={employeeLookupValue}
        setEmployeeLookupValue={setEmployeeLookupValue}
        employeeLookupBusy={employeeLookupBusy}
        employeeLookupError={employeeLookupError}
        employeeOrders={employeeOrders}
        employeeOrdersLoading={employeeOrdersLoading}
        employeeOrdersError={employeeOrdersError}
        scanInputRef={scanInputRef}
        scanValue={scanValue}
        setScanValue={setScanValue}
        scanBusy={scanBusy}
        scanError={scanError}
        labelScanInputRef={labelScanInputRef}
        labelScanValue={labelScanValue}
        setLabelScanValue={setLabelScanValue}
        labelScanBusy={labelScanBusy}
        labelScanError={labelScanError}
        employeeIssueOpen={employeeIssueOpen}
        setEmployeeIssueOpen={setEmployeeIssueOpen}
        employeeIssueInputRef={employeeIssueInputRef}
        employeeIssueValue={employeeIssueValue}
        setEmployeeIssueValue={setEmployeeIssueValue}
        employeeIssueBusy={employeeIssueBusy}
        employeeIssueError={employeeIssueError}
        employeeIssueLineNos={employeeIssueLineNos}
        setEmployeeIssueLineNos={setEmployeeIssueLineNos}
        handleEmployeeIssueSubmit={handleEmployeeIssueSubmit}
        handleEmployeeStart={handleEmployeeStart}
        handleEmployeeLookupScan={handleEmployeeLookupScan}
        handleProductScan={submitProductScan}
        handleLabelScan={submitLabelScan}
        formatDate={formatDate}
        formatDuration={formatDuration}
        formatFbsCells={formatFbsCells}
        orderItemsSummary={orderItemsSummary}
      />
    );
  }

  const showUsers = isSuper || tab === "employees";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="dot" />
          <div>
            <div className="title">Ozon Склад</div>
            <div className="subtitle">{isSuper ? "Супер админ" : "Админ"}</div>
          </div>
        </div>
        <div className="topbar-right">
          {storeOptions.length > 0 ? (
            <label className="store-select">
              <span>Магазин</span>
              <select className="input store-input" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                {storeOptions.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="user-chip">
            <div className="user-name">{displayUserName(currentUser)}</div>
            <div className="user-role">{isSuper ? "Супер админ" : "Админ"}</div>
          </div>
          <button className="ghost-button small" onClick={handleLogout} type="button">Выйти</button>
        </div>
      </header>

      {!isSuper && (
        <div className="tabs">
          <button className={`tab ${tab === "new" ? "active" : ""}`} onClick={() => setTab("new")} type="button">
            Новые
            <span className="badge">{newOrdersCount}</span>
          </button>
          <button className={`tab ${tab === "assembly" ? "active" : ""}`} onClick={() => setTab("assembly")} type="button">
            На сборке
            <span className="badge">{assemblyOrdersCount}</span>
          </button>
          <button className={`tab ${tab === "fbs_stock" ? "active" : ""} ${fbsStockAlertCount > 0 ? "alerting" : ""}`} onClick={() => setTab("fbs_stock")} type="button">
            Проверка остатков ФБС
            <span className={`badge ${fbsStockAlertCount > 0 ? "danger-badge" : ""}`}>{fbsStockTotals.all || 0}</span>
          </button>
          <button className={`tab ${tab === "stock_problems" ? "active" : ""} ${stockProblemsAlertCount > 0 ? "alerting" : ""}`} onClick={() => setTab("stock_problems")} type="button">
            Проблема остатков
            <span className={`badge ${stockProblemsAlertCount > 0 ? "danger-badge" : ""}`}>{stockProblemsAlertCount}</span>
          </button>
          <button className={`tab ${tab === "employees" ? "active" : ""}`} onClick={() => setTab("employees")} type="button">Сотрудники</button>
          <button className={`tab ${tab === "settings" ? "active" : ""}`} onClick={() => setTab("settings")} type="button">
            Настройки
            {openIssuesCount > 0 ? <span className="badge danger-badge">{openIssuesCount}</span> : null}
          </button>
        </div>
      )}

      {(isSuper || showUsers) && (
        <section className="card" style={{ marginBottom: 18 }}>
          <div className="section-header">
            <div className="section-title">Пользователи</div>
            <div className="hint">Логин и пароль берутся из общей базы сотрудников, здесь задаётся только доступ к OZ.</div>
          </div>
          {isSuper && (
            <div className="tabs" style={{ padding: "0 18px" }}>
              <button className={`tab ${userTab === "admins" ? "active" : ""}`} onClick={() => setUserTab("admins")} type="button">Админы</button>
              <button className={`tab ${userTab === "employees" ? "active" : ""}`} onClick={() => setUserTab("employees")} type="button">Сотрудники</button>
            </div>
          )}
          <div className="form-grid" style={{ padding: "16px 18px 0" }}>
            <label className="field">
              <span>Сотрудник</span>
              <UserDirectoryPicker
                value={createExternalUserId}
                onChange={setCreateExternalUserId}
                options={userDirectory.filter((entry) => !entry.alreadyAdded)}
                loading={userDirectoryLoading}
                disabled={userDirectoryLoading || userBusy}
              />
            </label>
            <label className="field">
              <span>Роль</span>
              <input className="input" value={isSuper ? (userTab === "admins" ? "Админ" : "Упаковщик") : "Упаковщик"} readOnly />
            </label>
            <div className="field"><span>&nbsp;</span><button className="primary-button" type="button" onClick={handleCreateUser} disabled={userBusy || userDirectoryLoading}>Добавить</button></div>
          </div>
          {userDirectoryError && <div className="alert small">{userDirectoryError}</div>}
          {usersError && <div className="alert small">{usersError}</div>}
          {userActionError && <div className="alert small">{userActionError}</div>}
          <div className="list users">
            <div className="list-header"><div className="col">Сотрудник</div><div className="col">Логин</div><div className="col">Роль</div><div className="col">Создан</div><div className="col right">Действия</div></div>
            <div className="list-body">
              {usersLoading ? <div className="empty">Загрузка...</div> : users.map((user) => (
                <div className="row" key={user.id}>
                  <div className="col"><div className="primary">{displayUserName(user)}</div></div>
                  <div className="col mono">{user.login || "—"}</div>
                  <div className="col mono">{roleLabel(user.role, user.position)}</div>
                  <div className="col">{formatDate(user.createdAt)}</div>
                  <div className="col right actions">
                    {user.role === "employee" ? (
                      <button
                        className="ghost-button small"
                        type="button"
                        onClick={() => {
                          setEmployeeStatsUser(user);
                          setEmployeeStatsData(null);
                          setEmployeeStatsError("");
                        }}
                      >
                        Статистика
                      </button>
                    ) : null}
                    <button className="ghost-button small" type="button" onClick={() => openEditUser(user)}>Роль</button>
                    <button className="ghost-button small danger" type="button" onClick={() => handleDeleteUser(user)}>Удалить</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {!isSuper && tab === "new" && (
        <section className="card">
          <div className="actions" style={{ padding: "16px 18px 0" }}>
            <div className="actions-left">
              <button className="ghost-button" type="button" onClick={() => loadNewOrders()} disabled={newLoading}>Обновить список</button>
            </div>
            <div className="hint">{newUpdatedAt ? `Обновлено: ${newUpdatedAt.toLocaleTimeString("ru-RU")}` : ""}</div>
          </div>
          {newError && <div className="alert">{newError}</div>}
          <div className="list orders new-orders">
            <div className="list-header"><div className="col">#</div><div className="col">Заказ</div><div className="col">Товары</div><div className="col">Статус</div><div className="col right">Создан</div></div>
            <div className="list-body">
              {newLoading ? <div className="empty">Загрузка...</div> : newOrders.length === 0 ? <div className="empty">Нет заказов в статусе «Ожидают сборки»</div> : newOrders.map((order, idx) => (
                <div className="row" key={order.postingNumber}>
                  <div className="col mono">{idx + 1}</div>
                  <div className="col"><div className="primary mono">{order.postingNumber}</div></div>
                  <div className="col"><div className="muted">{orderItemsSummary(order)}</div></div>
                  <div className="col"><span className="pill">{postingStatusLabel(order.status)}</span></div>
                  <div className="col right"><span>{timeAgo(order.createdAt)}</span></div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {!isSuper && tab === "assembly" && (
        <section className="card">
          <div className="actions" style={{ padding: "16px 18px 0" }}>
            <div className="actions-left">
              <button className="primary-button" type="button" onClick={() => setCreateOpen(true)}>Отправить заказы в сборку</button>
              <button
                className="ghost-button"
                type="button"
                onClick={() => handleSyncAwaitingDeliver({ loadLabels: true })}
                disabled={syncBusy}
              >
                {syncBusy ? "Синхронизация..." : "Синхр. и загрузить этикетки"}
              </button>
              <button
                className="ghost-button"
                type="button"
                onClick={() => handleSyncAwaitingDeliver({ loadLabels: false })}
                disabled={syncBusy}
              >
                {syncBusy ? "Синхронизация..." : "Синхр. без этикеток"}
              </button>
              <button className="ghost-button" type="button" onClick={() => loadAssemblies()} disabled={assembliesLoading}>Обновить список</button>
            </div>
          </div>
          {syncInfo && <div className="alert success">{syncInfo}</div>}
          {syncError && <div className="alert">{syncError}</div>}
          {assembliesError && <div className="alert">{assembliesError}</div>}
          <div className="list supplies">
            <div className="list-header"><div className="col">Сборка</div><div className="col">Этикетки</div><div className="col">Доступ</div><div className="col right">Осталось / всего</div></div>
            <div className="list-body">
              {assembliesLoading ? <div className="empty">Загрузка...</div> : assemblies.length === 0 ? <div className="empty">Сборок пока нет</div> : assemblies.map((assembly) => {
                const completed = isAssemblyCompleted(assembly);
                return (
                <button className={`row row-button ${completed ? "completed-supply" : ""}`} key={assembly.id} onClick={() => openAssembly(assembly)} type="button">
                  <div className="col">
                    <div className="primary">{assembly.name}</div>
                    <div className="muted">{assembly.storeName || "—"}</div>
                    {completed ? <div className="supply-status-glow">Собрана</div> : null}
                  </div>
                  <div className="col"><span className="pill">{assembly.labelsLoaded}/{assembly.labelsTotal || assembly.orderCount} · {labelsStatusLabel(assembly.labelsStatus)}</span></div>
                  <div className="col"><span className="pill">{accessModeLabel(assembly.accessMode)}</span></div>
                  <div className="col right"><span className="count">{Math.max(0, assembly.orderCount - assembly.collectedCount)} / {assembly.orderCount}</span></div>
                </button>
              )})}
            </div>
          </div>
        </section>
      )}

      {!isSuper && tab === "fbs_stock" && (
        <section className="card">
          <div className="actions" style={{ padding: "16px 18px 0" }}>
            <div className="actions-left">
              <button
                className="primary-button"
                type="button"
                onClick={() => loadFbsStockCheck({ force: true })}
                disabled={fbsStockLoading || fbsStockRefreshing}
              >
                {fbsStockLoading || fbsStockRefreshing ? "Обновляем..." : "Обновить"}
              </button>
              <div className="hint">
                Склад: <strong>{fbsStockWarehouseName || "—"}</strong>
                {visibleFbsStockStores.length ? ` • магазинов в отчёте: ${visibleFbsStockStores.length}` : ""}
                {fbsStockUpdatedAt ? ` • обновлено ${fbsStockUpdatedAt.toLocaleTimeString("ru-RU")}` : ""}
                {fbsStockRefreshing ? " • идёт обновление" : ""}
              </div>
            </div>
            <div className="actions-left">
              <span className="pill">Всего: {fbsStockTotals.all || 0}</span>
              <span className="count">ОК: {fbsStockTotals.ok || 0}</span>
              <span className="pill">Дефицит: {fbsStockTotals.shortage || 0}</span>
              <span className="pill">Ошибки: {fbsStockTotals.errors || 0}</span>
            </div>
          </div>
          {fbsStockRefreshing ? (
            <div className="fbs-progress-card">
              <div className="fbs-progress-head">
                <div className="primary">{fbsStockProgress.message || "Обновляем проверку остатков..."}</div>
                <div className="mono muted">
                  {fbsStockProgress.done || 0}
                  {fbsStockProgress.total > 0 ? ` / ${fbsStockProgress.total}` : ""} •{" "}
                  {Math.round(Number(fbsStockProgress.percent || 0))}%
                </div>
              </div>
              <div className="progress">
                <span style={{ width: `${Math.max(0, Math.min(100, Number(fbsStockProgress.percent || 0)))}%` }} />
              </div>
              <div className="hint">
                {fbsStockProgress.current?.article
                  ? `Сейчас: ${fbsStockProgress.current.productName || "—"} • артикул ${fbsStockProgress.current.article} • нужно ${Number(fbsStockProgress.current.requiredQty || 0)}`
                  : "Подготовка данных для проверки..."}
              </div>
            </div>
          ) : null}
          {fbsStockError ? <div className="alert">{fbsStockError}</div> : null}
          <div className="list fbs-stock" style={{ "--fbs-grid-template": fbsStockGridTemplate }}>
            <div className="list-header">
              <div className="col">Название</div>
              <div className="col">Артикул</div>
              <div className="col">Штрихкод Ozon</div>
              {visibleFbsStockStores.map((store) => (
                <div className="col right" key={store.id}>{store.name || store.id}</div>
              ))}
              <div className="col right">Всего</div>
              <div className="col right">Остаток</div>
              <div className="col">Ячейка</div>
              <div className="col">Статус</div>
            </div>
            <div className="list-body">
              {fbsStockLoading || (fbsStockRefreshing && fbsStockItems.length === 0) ? (
                <div className="empty">Загрузка проверки остатков...</div>
              ) : fbsStockItems.length === 0 ? (
                <div className="empty">Нет данных для проверки</div>
              ) : (
                fbsStockItems.map((item) => (
                  <div
                    className={`row ${
                      item.msStatus === "insufficient"
                        ? "fbs-shortage"
                        : item.msStatus !== "ok"
                        ? "fbs-error"
                        : ""
                    }`}
                    key={item.key}
                    >
                      <div className="col">
                        <div className="primary">{item.productName || "—"}</div>
                        <div className="muted">Заказов: {item.orderCount || 0}</div>
                      </div>
                    <div className="col mono">{formatFbsValueList(item.articles?.length ? item.articles : item.article)}</div>
                    <div className="col mono">{formatFbsValueList(item.marketplaceBarcodes?.length ? item.marketplaceBarcodes : item.marketplaceBarcode)}</div>
                    {visibleFbsStockStores.map((store) => (
                      <div className="col right mono" key={`${item.key}:${store.id}`}>
                        {store.id ? item.byStore?.[store.id] || 0 : 0}
                      </div>
                    ))}
                    <div className="col right mono">{item.requiredQty || 0}</div>
                    <div className="col right mono">{item.msStockQty == null ? "—" : item.msStockQty}</div>
                    <div className="col mono">{formatFbsCells(item.msCells)}</div>
                    <div className="col">
                      {item.msStatus === "ok" ? (
                        <div className="primary">ОК</div>
                      ) : item.msStatus === "insufficient" ? (
                        <div className="primary text-danger">
                          Недостаточно: нужно {item.requiredQty || 0}, остаток {item.msStockQty ?? 0}
                        </div>
                      ) : (
                        <div className="primary text-danger">{item.msError || "Ошибка проверки"}</div>
                      )}
                      {Array.isArray(item.msMatches) && item.msMatches.length > 1 ? (
                        <div className="muted">
                          Совпадения:{" "}
                          {item.msMatches
                            .map((match) => [match.article, match.name].filter(Boolean).join(" • "))
                            .filter(Boolean)
                            .join(" | ")}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      )}

      {!isSuper && tab === "stock_problems" && (
        <section className="card">
          <div className="actions" style={{ padding: "16px 18px 0" }}>
            <div className="actions-left">
              <button className="primary-button" type="button" onClick={() => loadStockProblems()} disabled={stockProblemsLoading}>
                {stockProblemsLoading ? "Обновляем..." : "Обновить"}
              </button>
              <div className="hint">
                Склад: <strong>Ижевск FBS</strong>
                {stockProblemsUpdatedAt ? ` • обновлено ${stockProblemsUpdatedAt.toLocaleTimeString("ru-RU")}` : ""}
              </div>
            </div>
            <div className="actions-left">
              <span className="pill">Полки в минусе: {stockProblems.negativeShelves.length}</span>
              <span className="pill">Сотрудники в минусе: {stockProblems.negativeEmployees.length}</span>
              <span className="pill">Остатки у сотрудников: {stockProblems.leftoverEmployees.length}</span>
            </div>
          </div>
          {stockProblemsError ? <div className="alert">{stockProblemsError}</div> : null}

          <div className="section-header">
            <div className="section-title">Полки в минусе</div>
          </div>
          <div className="list">
            <div className="list-header">
              <div className="col">Ячейка</div>
              <div className="col">Товар</div>
              <div className="col right">Остаток</div>
              <div className="col">Кто уводил</div>
            </div>
            <div className="list-body">
              {stockProblemsLoading ? (
                <div className="empty">Загрузка...</div>
              ) : stockProblems.negativeShelves.length === 0 ? (
                <div className="empty">Отрицательных остатков на полках нет</div>
              ) : (
                stockProblems.negativeShelves.map((item) => (
                  <div className="row" key={`neg-shelf-${item.shelfId}-${item.productId}`}>
                    <div className="col mono">{item.shelfName || "—"}</div>
                    <div className="col">
                      <div className="primary">{item.productName || "—"}</div>
                      <div className="muted mono">{item.article || "—"}</div>
                    </div>
                    <div className="col right mono">{item.quantity}</div>
                    <div className="col">
                      <div className="primary">{(item.employees || []).join(", ") || "—"}</div>
                      <div className="muted">{item.lastMovementAt ? new Date(item.lastMovementAt).toLocaleString("ru-RU") : "—"}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="section-header">
            <div className="section-title">Сотрудники в минусе</div>
          </div>
          <div className="list">
            <div className="list-header">
              <div className="col">Сотрудник</div>
              <div className="col">Товар</div>
              <div className="col right">Остаток</div>
            </div>
            <div className="list-body">
              {stockProblemsLoading ? (
                <div className="empty">Загрузка...</div>
              ) : stockProblems.negativeEmployees.length === 0 ? (
                <div className="empty">Сотрудников с отрицательным остатком нет</div>
              ) : (
                stockProblems.negativeEmployees.map((item) => (
                  <div className="row" key={`neg-emp-${item.employeeId}-${item.productId}`}>
                    <div className="col">{item.employeeName || "—"}</div>
                    <div className="col">
                      <div className="primary">{item.productName || "—"}</div>
                      <div className="muted mono">{item.article || "—"}</div>
                    </div>
                    <div className="col right mono">{item.quantity}</div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="section-header">
            <div className="section-title">Остатки у сотрудников</div>
          </div>
          <div className="list">
            <div className="list-header">
              <div className="col">Сотрудник</div>
              <div className="col">Товар</div>
              <div className="col right">Остаток</div>
            </div>
            <div className="list-body">
              {stockProblemsLoading ? (
                <div className="empty">Загрузка...</div>
              ) : stockProblems.leftoverEmployees.length === 0 ? (
                <div className="empty">Лишних остатков у сотрудников нет</div>
              ) : (
                stockProblems.leftoverEmployees.map((item) => (
                  <div className="row" key={`left-emp-${item.employeeId}-${item.productId}`}>
                    <div className="col">{item.employeeName || "—"}</div>
                    <div className="col">
                      <div className="primary">{item.productName || "—"}</div>
                      <div className="muted mono">{item.article || "—"}</div>
                    </div>
                    <div className="col right mono">{item.quantity}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      )}

      {!isSuper && tab === "settings" && (
        <section className="card">
          <div className="section-header">
            <div className="section-title">Ошибки сотрудников</div>
            <div className="hint">Проблемные сканы, которые требуют исправления карточек или ручного фикса.</div>
          </div>
          {scanIssuesError ? <div className="alert">{scanIssuesError}</div> : null}
          <div className="list issues">
            <div className="list-header">
              <div className="col">Сборка</div>
              <div className="col">Заказ</div>
              <div className="col">Сотрудник</div>
              <div className="col">Данные</div>
              <div className="col">Создано</div>
              <div className="col right actions">Действия</div>
            </div>
            <div className="list-body">
              {scanIssuesLoading ? (
                <div className="empty">Загрузка...</div>
              ) : scanIssues.length === 0 ? (
                <div className="empty">Открытых ошибок нет</div>
              ) : (
                scanIssues.map((issue) => (
                  <div className="row" key={issue.id}>
                    <div className="col">
                      <div className="primary">{issue.assemblyName || issue.assemblyId}</div>
                      <div className="muted mono">{issue.assemblyId} · {issue.issueStageLabel || "Сборка заказов"}</div>
                      {issue.errorMessage ? <div className="alert small">{issue.errorMessage}</div> : null}
                      {issue.contextNote ? <div className="muted">{issue.contextNote}</div> : null}
                    </div>
                    <div className="col">
                      <div className="primary mono">{issue.postingNumber || "—"}</div>
                      <div className="muted">Строки: {(issue.lineNos || []).join(", ") || "—"}</div>
                    </div>
                    <div className="col">
                      <div className="primary">{issue.employeeSurname} {issue.employeeName}</div>
                    </div>
                    <div className="col">
                      <div className="primary">{(issue.itemNames || []).join(", ") || "—"}</div>
                      <div className="muted">Артикулы: {(issue.itemArticles || []).join(", ") || "—"}</div>
                      <div className="muted">Баркоды: {(issue.productBarcodes || []).join(", ") || "—"}</div>
                      <div className="muted">Скан: {issue.scannedBarcode || "—"}</div>
                    </div>
                    <div className="col">{formatDate(issue.createdAt)}</div>
                    <div className="col right actions">
                      <button className="ghost-button small" type="button" onClick={() => handleResolveScanIssue(issue.id)} disabled={scanIssueActionBusyId === issue.id}>
                        Решена
                      </button>
                      <button className="primary-button small" type="button" onClick={() => handleFixScanIssue(issue.id)} disabled={scanIssueActionBusyId === issue.id}>
                        {issue.issueStage === "pick_scan" ? "Разрешить без шк" : "Фикс"}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      )}

      {createOpen && (
        <div className="modal-backdrop" onClick={() => setCreateOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Отправить заказы в сборку</div>
                <div className="modal-subtitle">Выбранные заказы сменят статус на «Ожидают отгрузки», затем загрузятся этикетки</div>
              </div>
              <button className="icon-button" onClick={() => setCreateOpen(false)} type="button">×</button>
            </div>
            <div className="modal-body">
              <div className="section">
                <div className="section-title">Режим создания</div>
                <div className="mode-toggle">
                  <button className={`chip ${createMode === "count" ? "active" : ""}`} onClick={() => setCreateMode("count")} type="button">По количеству заказов</button>
                  <button className={`chip ${createMode === "articles" ? "active" : ""}`} onClick={() => setCreateMode("articles")} type="button">По артикулам</button>
                </div>
              </div>

              {createMode === "count" ? (
                <div className="form-grid">
                  <label className="field"><span>Количество заказов</span><input className="input" type="number" min="1" value={createCount} onChange={(e) => setCreateCount(e.target.value)} /></label>
                  <label className="field"><span>Сортировка</span><select className="input" value={createSort} onChange={(e) => setCreateSort(e.target.value)}><option value="newest">Сначала новые</option><option value="oldest">Сначала старые</option></select></label>
                </div>
              ) : (
                <div className="section">
                  <div className="section-title">Выбор по артикулам (кол-во штук)</div>
                  <div className="article-rows">
                    {articleRows.map((row) => (
                      <div className="article-row" key={row.id}>
                        <label className="field"><span>Артикул</span><input className="input" list="oz-article-list" value={row.article} onChange={(e) => setArticleRows((prev) => prev.map((it) => it.id === row.id ? { ...it, article: e.target.value.trim() } : it))} /></label>
                        <label className="field"><span>Кол-во</span><input className="input" type="number" min="1" value={row.count} onChange={(e) => setArticleRows((prev) => prev.map((it) => it.id === row.id ? { ...it, count: Number(e.target.value) || 1 } : it))} /></label>
                        <label className="field"><span>Порядок</span><select className="input" value={row.sortDir} onChange={(e) => setArticleRows((prev) => prev.map((it) => it.id === row.id ? { ...it, sortDir: e.target.value } : it))}><option value="newest">Новые</option><option value="oldest">Старые</option></select></label>
                        <button className="ghost-button small" type="button" onClick={() => setArticleRows((prev) => prev.length > 1 ? prev.filter((it) => it.id !== row.id) : prev)}>Удалить</button>
                      </div>
                    ))}
                  </div>
                  <button className="ghost-button" type="button" onClick={() => setArticleRows((prev) => [...prev, { id: rowIdRef.current++, article: "", count: 1, sortDir: "newest" }])}>Добавить артикул</button>
                  <datalist id="oz-article-list">
                    {articleOptions.map((opt) => <option key={opt.article} value={opt.article}>{opt.name ? `${opt.article} — ${opt.name}` : opt.article}</option>)}
                  </datalist>
                </div>
              )}

              <div className="preview">
                <div className="preview-row"><span>Выбрано заказов</span><strong>{selectedForCreate.length}</strong></div>
                <div className="preview-row"><span>Доступно новых</span><span>{newOrders.length}</span></div>
              </div>

              <div className="section">
                <div className="section-title">Товары из вкладки «Новые»</div>
                <div className="list items compact preview create-items-list">
                  <div className="list-header"><div className="col">Артикул</div><div className="col">Название</div><div className="col right">Кол-во</div></div>
                  <div className="list-body">
                    {newItems.length === 0 ? <div className="empty">Нет товаров</div> : newItems.map((item) => (
                      <div className="row" key={`${item.article}-${item.name}`}>
                        <div className="col"><div className="primary mono">{item.article}</div></div>
                        <div className="col">{item.name || "-"}</div>
                        <div className="col right"><span className="count">{item.count}</span></div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {createError && <div className="alert small">{createError}</div>}
              <div className="modal-actions">
                <button className="ghost-button" type="button" onClick={() => setCreateOpen(false)}>Отмена</button>
                <button className="primary-button" type="button" onClick={handleCreateAssembly} disabled={createBusy}>{createBusy ? "Отправляю..." : "Отправить в сборку"}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {selectedAssembly && (
        <div className="modal-backdrop" onClick={() => setSelectedAssembly(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">
                  {selectedAssembly.name}
                  {isSelectedAssemblyCompleted ? <span className="modal-status-glow">Собрана</span> : null}
                </div>
                <div className="modal-subtitle">
                  {assemblyTab === "items"
                    ? "Товары в сборке"
                    : assemblyTab === "shipment"
                      ? "Отгрузка"
                      : assemblyTab === "settings"
                        ? "Настройки сборки"
                        : "Заказы в сборке"}
                  {selectedAssembly.storeName ? ` • ${selectedAssembly.storeName}` : ""}
                  {` • ${selectedAssembly.id}`}
                </div>
              </div>
              <div className="modal-actions-inline">
                {assemblyTab === "items" && (
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={handleExportAssemblyItems}
                    disabled={assemblyItems.length === 0}
                  >
                    Экспорт в Excel
                  </button>
                )}
                <button className="icon-button" onClick={() => setSelectedAssembly(null)} type="button">×</button>
              </div>
            </div>

            <div className="modal-tabs">
              <button className={`modal-tab ${assemblyTab === "orders" ? "active" : ""}`} onClick={() => setAssemblyTab("orders")} type="button">Заказы</button>
              <button className={`modal-tab ${assemblyTab === "items" ? "active" : ""}`} onClick={() => setAssemblyTab("items")} type="button">Товары</button>
              <button className={`modal-tab ${assemblyTab === "shipment" ? "active" : ""}`} onClick={() => setAssemblyTab("shipment")} type="button">Отгрузка</button>
              <button className={`modal-tab ${assemblyTab === "settings" ? "active" : ""}`} onClick={() => setAssemblyTab("settings")} type="button">Настройки</button>
            </div>

            <div className="modal-body">
              {assemblyTab === "orders" ? (
                <>
                  <div className="actions">
                    <div className="actions-left">
                      <button className="ghost-button" type="button" onClick={() => handleRefreshLabels({ force: false })} disabled={settingsBusy}>Обновить этикетки</button>
                    </div>
                    <div className="hint">Собрано заказов: {assemblyTotals.collected} / {assemblyTotals.total}</div>
                  </div>
                  {assemblyOrdersError && <div className="alert small">{assemblyOrdersError}</div>}
                  <div className="list orders compact assembly-orders-list">
                    <div className="list-header"><div className="col">Заказ</div><div className="col">Товары</div><div className="col">Сборка</div><div className="col right">Статус</div></div>
                    <div className="list-body">
                      {assemblyOrdersLoading ? <div className="empty">Загрузка...</div> : assemblyOrders.map((order) => {
                        return (
                          <div className={`row ${order.assignedUserId ? "assigned" : ""}`} key={order.postingNumber}>
                            <div className="col"><div className="primary mono">{order.postingNumber}</div><div className="muted">{formatDate(order.createdAt)}</div></div>
                            <div className="col"><div className="muted">{order.items.map((it) => {
                              const article = it.article || "-";
                              const name = String(it.name || "").trim();
                              return name ? `${article} (${name}) x${it.quantity}` : `${article} x${it.quantity}`;
                            }).join(", ")}</div></div>
                            <div className="col"><span className="count">{order.scannedItems}/{order.totalItems}</span></div>
                            <div className="col right"><span className="pill">{order.sentToDeliveringAt ? "Отгружен" : order.collectedAt ? "Собран" : "Ожидает сборки"}</span></div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              ) : assemblyTab === "items" ? (
                <div className="list items compact assembly-items-list">
                  <div className="list-header">
                    <div className="col">Фото</div>
                    <div className="col">Артикул продавца</div>
                    <div className="col">Название</div>
                    <div className="col">Штрихкод Ozon</div>
                    <div className="col right">Кол-во</div>
                  </div>
                  <div className="list-body">
                    {assemblyOrdersLoading ? (
                      <div className="empty">Загрузка...</div>
                    ) : assemblyItems.length === 0 ? (
                      <div className="empty">Нет товаров в этой сборке</div>
                    ) : (
                      assemblyItems.map((item) => (
                        <div className="row" key={`${item.article}-${item.name}-${item.sku || "-"}`}>
                          <div className="col">
                            <AdminProductPhoto src={item.imageUrl} alt={item.name || "Фото товара"} />
                          </div>
                          <div className="col"><div className="primary mono">{item.article || "-"}</div></div>
                          <div className="col">{item.name || "-"}</div>
                          <div className="col mono">{item.marketplaceBarcode || "-"}</div>
                          <div className="col right"><span className="count">{item.count}</span></div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ) : assemblyTab === "shipment" ? (
                <div className="shipment-panel">
                  <div className="shipment-hero">
                    <div className="shipment-hero-main">
                      <div className="section-title">Поставка</div>
                      <div className="shipment-code">{assemblyShipment?.code || "Не сформирована"}</div>
                      <div className="hint">
                        Готово к отгрузке: {Number(assemblyTotals.readyToShip || readyToShipOrders.length)} заказов
                      </div>
                    </div>
                    <div className="shipment-hero-actions">
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={handlePrepareShipment}
                        disabled={shipmentBusy || readyToShipOrders.length === 0}
                      >
                        {shipmentBusy ? "Формирую..." : assemblyShipment?.hasDraft ? "Пересобрать поставку" : "Сформировать поставку"}
                      </button>
                      <button
                        className="primary-button"
                        type="button"
                        onClick={handleConfirmShipment}
                        disabled={shipmentBusy || readyToShipOrders.length === 0}
                      >
                        {shipmentBusy ? "Подтверждаю..." : "Подтвердить отгрузку"}
                      </button>
                    </div>
                  </div>

                  <div className="shipment-grid">
                    <div className="settings-card">
                      <div className="preview-row"><span>Сформирована</span><strong>{formatDate(assemblyShipment?.preparedAt)}</strong></div>
                      <div className="preview-row"><span>Подтверждена</span><strong>{formatDate(assemblyShipment?.confirmedAt)}</strong></div>
                      <div className="preview-row"><span>Заказов в поставке</span><strong>{shipmentPostingNumbers.length}</strong></div>
                      <div className="preview-row"><span>Осталось не отгружено</span><strong>{readyToShipOrders.length}</strong></div>
                    </div>
                    <div className="settings-card">
                      <div className="section-title">Штрихкод Ozon</div>
                      <div className="hint small">Штрихкод акта для передачи курьеру и пропуска на СЦ.</div>
                      <div className="settings-actions">
                        <a
                          className={`primary-button ${shipmentBarcodeUrl ? "" : "disabled-link"}`}
                          href={shipmentBarcodeUrl || "#"}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(event) => {
                            if (!shipmentBarcodeUrl) event.preventDefault();
                          }}
                        >
                          Штрихкод акта (PNG)
                        </a>
                      </div>
                    </div>
                  </div>

                  {shipmentNotice && <div className="alert success small">{shipmentNotice}</div>}
                  {shipmentError && <div className="alert small">{shipmentError}</div>}

                  <div className="list orders compact assembly-orders-list shipment-orders-list">
                    <div className="list-header"><div className="col">Заказы в поставке</div><div className="col right">Статус</div></div>
                    <div className="list-body">
                      {shipmentPostingNumbers.length === 0 ? (
                        <div className="empty">Сначала сформируйте поставку</div>
                      ) : (
                        shipmentPostingNumbers.map((postingNumber) => {
                          const order = assemblyOrders.find((item) => item.postingNumber === postingNumber) || null;
                          return (
                            <div className="row" key={postingNumber}>
                              <div className="col">
                                <div className="primary mono">{postingNumber}</div>
                                <div className="muted">
                                  {order ? orderItemsSummary(order) : "Заказ уже отгружен или не найден в текущем списке"}
                                </div>
                              </div>
                              <div className="col right">
                                <span className={`pill ${order?.sentToDeliveringAt ? "active-pill" : ""}`}>
                                  {order?.sentToDeliveringAt ? "Отгружен" : "К отгрузке"}
                                </span>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="settings-grid">
                    <div className="settings-card">
                      <div className="preview-row"><span>Магазин</span><strong>{assemblySettings?.storeName || selectedAssembly?.storeName || "—"}</strong></div>
                      <div className="section-title">Доступ к сборке</div>
                      <div className="mode-toggle">
                        {[
                          { value: "hidden", label: "Скрыта" },
                          { value: "selected_split", label: "Выбранным с разделением" },
                        ].map((mode) => (
                          <button
                            key={mode.value}
                            type="button"
                            className={`chip ${accessMode === mode.value ? "active" : ""}`}
                            onClick={() => handleAccessModeChange(mode.value)}
                            disabled={settingsBusy}
                          >
                            {mode.label}
                          </button>
                        ))}
                      </div>

                      <div className="section">
                        <div className="section-title">Метод сборки упаковщика</div>
                        <label className="employee-chip">
                          <input
                            type="checkbox"
                            checked={employeeWorkflowIsPicking}
                            onChange={(event) => handleEmployeeWorkflowModeChange(event.target.checked)}
                            disabled={settingsBusy}
                          />
                          <span>Включить новый метод: сначала сборка товара, потом упаковка заказов</span>
                        </label>
                        <div className="hint small">
                          {employeeWorkflowIsPicking
                            ? employeeWorkflowStage === "pick_active"
                              ? "Новый метод включён, сборка товара уже запущена."
                              : employeeWorkflowStage === "pick_pending"
                                ? "Новый метод включён. После распределения нужно отдельно нажать запуск сборки товара."
                                : "Новый метод включён, но сборка пока не распределена."
                            : "Старый метод: сотрудники сразу переходят к упаковке заказов."}
                        </div>
                      </div>

                      <div className="section">
                        <div className="section-title">Метод работы с остатками</div>
                        <label className="employee-chip">
                          <input
                            type="checkbox"
                            checked={stockMethodEnabled}
                            onChange={(event) => handleStockMethodChange(event.target.checked)}
                            disabled={settingsBusy}
                          />
                          <span>Новый метод: при сканировании двигать товар по складу и списывать после сборки заказа</span>
                        </label>
                        <div className="hint small">
                          {stockMethodEnabled
                            ? "Новый складской метод включён: pick-scan переносит товар сотруднику, collected_at списывает его у сотрудника."
                            : "Старый складской метод: сборка идёт без перемещений и списаний в складской БД."}
                        </div>
                      </div>

                      {accessMode === "selected_split" && (
                        <div className="section">
                          <div className="section-title">Сотрудники</div>
                          <div className="hint small">
                            Выбрано: {accessUsers.length}
                            {assemblyEmployeeQuery.trim() ? ` • найдено: ${filteredAssemblyEmployees.length}` : ""}
                          </div>
                          <label className="field employee-search-field">
                            <span>Поиск сотрудника</span>
                            <input
                              className="input"
                              value={assemblyEmployeeQuery}
                              onChange={(e) => setAssemblyEmployeeQuery(e.target.value)}
                              placeholder="Фамилия или имя"
                            />
                          </label>
                          <div className="employee-grid-shell">
                            <div className="employee-grid">
                              {assemblyEmployees.length === 0 ? (
                                <div className="empty">Нет сотрудников</div>
                              ) : filteredAssemblyEmployees.length === 0 ? (
                                <div className="empty">Ничего не найдено</div>
                              ) : (
                                filteredAssemblyEmployees.map((emp) => (
                                  <label className="employee-chip" key={emp.id}>
                                    <input
                                      type="checkbox"
                                      checked={accessUsers.includes(emp.id)}
                                      onChange={(e) => {
                                        setAssemblyAccessDirty(true);
                                        setAccessUsers((prev) =>
                                          e.target.checked
                                            ? Array.from(new Set([...prev, emp.id]))
                                            : prev.filter((id) => id !== emp.id)
                                        );
                                      }}
                                    />
                                    <span>{emp.surname} {emp.name}</span>
                                  </label>
                                ))
                              )}
                            </div>
                          </div>
                          <button
                            className="primary-button"
                            type="button"
                            onClick={handleSaveAccessUsers}
                            disabled={settingsBusy}
                          >
                            Сохранить доступ
                          </button>
                        </div>
                      )}

                      {accessMode === "selected_split" && (
                        <div className="section">
                          <div className="section-title">Распределение</div>
                          <div className="settings-actions">
                            <button
                              className="primary-button"
                              type="button"
                              onClick={() => handleSplitAssembly("split")}
                              disabled={settingsBusy || accessUsers.length === 0}
                            >
                              Разделить
                            </button>
                            <button
                              className="ghost-button"
                              type="button"
                              onClick={() => handleSplitAssembly("redistribute")}
                              disabled={settingsBusy || accessUsers.length === 0 || !hasAssignments}
                            >
                              Перераздать
                            </button>
                          </div>
                          {employeeWorkflowIsPicking ? (
                            <div className="settings-actions">
                              <button
                                className="primary-button"
                                type="button"
                                onClick={handleStartProductPicking}
                                disabled={
                                  settingsBusy ||
                                  accessUsers.length === 0 ||
                                  !hasAssignments ||
                                  employeeWorkflowStage !== "pick_pending"
                                }
                              >
                                Начать сборку товара
                              </button>
                              <div className="hint small">
                                {employeeWorkflowStage === "pick_active"
                                  ? "Сборка товара уже запущена."
                                  : employeeWorkflowStage === "pick_pending"
                                    ? "Запустите этап после распределения, чтобы упаковщики сначала собрали товар."
                                    : "Сначала распределите сборку между упаковщиками."}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      )}

                      {accessMode !== "hidden" && (
                        <button
                          className="ghost-button small"
                          type="button"
                          onClick={handleHideAssembly}
                          disabled={settingsBusy}
                        >
                          Скрыть сборку
                        </button>
                      )}
                    </div>

                    <div className="settings-card">
                      <div className="section-title">Этикетки</div>
                      <div className="preview-row"><span>Статус</span><strong>{labelsStatusLabel(assemblySettings?.labelsStatus)}</strong></div>
                      <div className="progress"><span style={{ width: `${Math.min(100, ((assemblySettings?.labelsLoaded || 0) / Math.max(1, assemblySettings?.labelsTotal || 1)) * 100)}%` }} /></div>
                      <div className="preview-row"><span>Загружено</span><strong>{assemblySettings?.labelsLoaded || 0} / {assemblySettings?.labelsTotal || 0}</strong></div>
                      {assemblySettings?.labelsError && <div className="alert small">{labelErrorText(assemblySettings.labelsError)}</div>}
                      <div className="settings-actions">
                        <button className="ghost-button" type="button" onClick={() => handleRefreshLabels({ force: false })} disabled={settingsBusy}>
                          Повторить
                        </button>
                        <button className="ghost-button" type="button" onClick={() => handleRefreshLabels({ force: true })} disabled={settingsBusy}>
                          Форс
                        </button>
                        <button className="ghost-button" type="button" onClick={handleReloadLabelDiagnostics} disabled={assemblyLabelDiagnosticsLoading}>
                          Диагностика
                        </button>
                      </div>
                      <div className="label-diagnostics-card">
                        <div className="preview-row"><span>Диагностика</span><strong>{assemblyLabelDiagnostics?.jobRunning ? "Загрузка активна" : "Ожидание"}</strong></div>
                        <div className="preview-row"><span>Ошибок</span><strong>{assemblyLabelDiagnostics?.failedCount || 0}</strong></div>
                        <div className="preview-row"><span>Не загружено</span><strong>{assemblyLabelDiagnostics?.pendingCount || 0}</strong></div>
                        <div className="preview-row"><span>Требуют повтора</span><strong>{assemblyLabelDiagnostics?.retryableFailedCount || 0}</strong></div>
                        {assemblyLabelDiagnosticsLoading ? <div className="hint small">Обновление диагностики...</div> : null}
                        {assemblyLabelDiagnosticsError ? <div className="alert small">{assemblyLabelDiagnosticsError}</div> : null}
                        {assemblyLabelDiagnostics?.recommendation ? (
                          <div className="hint small label-recommendation">{assemblyLabelDiagnostics.recommendation}</div>
                        ) : null}
                        {assemblyLabelDiagnostics?.problemBuckets?.length ? (
                          <div className="label-problem-buckets">
                            {assemblyLabelDiagnostics.problemBuckets.map((bucket) => (
                              <span className="label-problem-bucket" key={bucket.code}>
                                {bucket.title}: {bucket.count}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {assemblyLabelDiagnostics?.failedOrders?.length ? (
                          <div className="label-failures">
                            {assemblyLabelDiagnostics.failedOrders.slice(0, 8).map((item) => (
                              <div className="label-failure-row" key={item.postingNumber}>
                                <div>
                                  <div className="primary mono">{item.postingNumber}</div>
                                  <div className="muted">{item.title}</div>
                                </div>
                                <div className="muted label-failure-text">{item.error}</div>
                                {item.recommendation ? <div className="hint small">{item.recommendation}</div> : null}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {accessMode === "selected_split" && hasAssignments && (
                    <div className="section">
                      <div className="section-title">Прогресс сотрудников</div>
                      <div className="hint small">
                        Собрано: {assemblyTotals.collected} / {assemblyTotals.total}
                      </div>
                      {assemblyTotals.total > 0 && assemblyTotals.remaining === 0 ? (
                        <div className="hint small success">Все заказы собраны, сборка будет скрыта автоматически</div>
                      ) : null}
                      <div className="progress-list">
                        {assemblyProgress.map((item) => (
                          <div className="progress-row" key={item.id}>
                            <div className="primary">{item.surname} {item.name}</div>
                            <div className="progress-row-actions">
                              <button
                                className="ghost-button small"
                                type="button"
                                onClick={() => handleExportAssemblyEmployeeItems(item)}
                                disabled={settingsBusy || Number(item.total || 0) < 1}
                              >
                                Экспорт товаров
                              </button>
                              <div className="pill">{item.collected || 0} / {item.total || 0}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {assemblySettingsNotice && <div className="alert success small">{assemblySettingsNotice}</div>}
                  {assemblySettingsError && <div className="alert small">{assemblySettingsError}</div>}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <AdminEmployeeStatsModal
        employee={employeeStatsUser}
        statsData={employeeStatsData}
        statsLoading={employeeStatsLoading}
        statsError={employeeStatsError}
        rangeKey={employeeStatsRangeKey}
        setRangeKey={setEmployeeStatsRangeKey}
        customFrom={employeeStatsCustomFrom}
        setCustomFrom={setEmployeeStatsCustomFrom}
        customTo={employeeStatsCustomTo}
        setCustomTo={setEmployeeStatsCustomTo}
        onApplyCustomRange={() => loadEmployeeStats(employeeStatsUser, {
          rangeKey: employeeStatsRangeKey,
          customFrom: employeeStatsCustomFrom,
          customTo: employeeStatsCustomTo,
        })}
        onClose={() => {
          setEmployeeStatsUser(null);
          setEmployeeStatsData(null);
          setEmployeeStatsError("");
        }}
      />

      {editUser && (
        <div className="modal-backdrop" onClick={() => setEditUser(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><div><div className="modal-title">Роль пользователя</div><div className="modal-subtitle">{displayUserName(editUser)}</div></div><button className="icon-button" type="button" onClick={() => setEditUser(null)}>×</button></div>
            <div className="modal-body">
              <div className="form-grid">
                <label className="field">
                  <span>Логин</span>
                  <input className="input" value={editUser.login || ""} readOnly />
                </label>
                <label className="field">
                  <span>Роль на сайте</span>
                  <select className="input" value={editRole} onChange={(e) => setEditRole(e.target.value)}>
                    {isSuper ? <option value="admin">Админ</option> : null}
                    <option value="employee">Упаковщик</option>
                  </select>
                </label>
              </div>
              {userActionError && <div className="alert small">{userActionError}</div>}
              <div className="modal-actions">
                <button className="ghost-button" type="button" onClick={() => setEditUser(null)}>Отмена</button>
                <button className="primary-button" type="button" onClick={handleSaveUser} disabled={userBusy}>Сохранить</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
