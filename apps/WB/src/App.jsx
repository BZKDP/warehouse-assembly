import { useEffect, useMemo, useRef, useState } from "react";
import LoginView from "./views/LoginView.jsx";
import { useCallback, useLayoutEffect } from "react";
import SuperAdminView from "./views/SuperAdminView.jsx";
import EmployeeView from "./views/EmployeeView.jsx";
import CollectorView from "./views/CollectorView.jsx";
import AdminEmployeeStatsModal from "./views/AdminEmployeeStatsModal.jsx";
import UserDirectoryPicker from "./components/UserDirectoryPicker.jsx";
import "./App.css";
const REFRESH_MS = 30000;
const REFRESH_SUPPLIES_MS = 5000;
const REFRESH_NEW_ORDERS_MS = 15000;
const REFRESH_FAST_MS = 3000;
const REFRESH_ISSUES_MS = 10000;
const API_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;
const PAGE_SIZE = 50;
const MOSCOW_OFFSET = "+03:00";
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

function timeAgo(iso) {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs)) return "—";
  const totalMin = Math.max(0, Math.floor(diffMs / 60000));
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  return `${hours} ч ${minutes} мин назад`;
}

function formatDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("ru-RU");
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

function isSupplyCompleted(supply) {
  const total = Number(supply?.orderCount ?? 0);
  const collected = Number(supply?.collectedCount ?? 0);
  return total > 0 && collected >= total;
}

function WorkflowProgress({ label, done, total, tone = "orders" }) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeDone = Math.max(0, Math.min(safeTotal, Number(done) || 0));
  const percent = safeTotal > 0 ? Math.min(100, Math.round((safeDone / safeTotal) * 100)) : 0;
  return (
    <div className={`workflow-progress ${tone}`}>
      <div className="workflow-progress-head">
        <span>{label}</span>
        <strong>{safeDone} / {safeTotal}</strong>
      </div>
      <div className="workflow-progress-track" role="progressbar" aria-label={label} aria-valuemin="0" aria-valuemax={safeTotal} aria-valuenow={safeDone}>
        <span style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function aggregatePickingProgress(entries) {
  return (Array.isArray(entries) ? entries : []).reduce(
    (result, entry) => ({
      total: result.total + Math.max(0, Number(entry?.pickingTotal) || 0),
      done: result.done + Math.max(0, Number(entry?.pickingCollected) || 0),
    }),
    { total: 0, done: 0 }
  );
}

function supplyAccessLabel(supply) {
  if (!supply) return "";
  const mode = supply.accessMode;
  if (mode === "hidden") return "Доступ: скрыт";
  const count = supply.accessUserCount ?? 0;
  return `Сотрудники: ${count}`;
}

function getMoscowDateString(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function shiftDateString(dateStr, deltaDays) {
  if (!dateStr) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const next = new Date(Date.UTC(year, month - 1, day + deltaDays));
  if (Number.isNaN(next.getTime())) return "";
  const nextYear = next.getUTCFullYear();
  const nextMonth = String(next.getUTCMonth() + 1).padStart(2, "0");
  const nextDay = String(next.getUTCDate()).padStart(2, "0");
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

function buildRangePayload(fromDate, toDate) {
  if (!fromDate || !toDate) return { from: null, to: null };
  const from = new Date(`${fromDate}T00:00:00${MOSCOW_OFFSET}`);
  const toExclusive = new Date(`${shiftDateString(toDate, 1)}T00:00:00${MOSCOW_OFFSET}`);
  return {
    from: Number.isNaN(from.getTime()) ? null : from.toISOString(),
    to: Number.isNaN(toExclusive.getTime()) ? null : toExclusive.toISOString(),
  };
}

function resolveStatsRange(rangeKey, customFrom, customTo) {
  const today = getMoscowDateString();
  if (rangeKey === "today") {
    return buildRangePayload(today, today);
  }
  if (rangeKey === "7d") {
    return buildRangePayload(shiftDateString(today, -6), today);
  }
  if (rangeKey === "30d") {
    return buildRangePayload(shiftDateString(today, -29), today);
  }
  if (rangeKey === "month") {
    const [year, month] = today.split("-");
    return buildRangePayload(`${year}-${month}-01`, today);
  }
  return buildRangePayload(customFrom, customTo);
}

async function fetchJson(url, options) {
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

function sanitizeFilePart(value, fallback = "export") {
  const normalized = String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function aggregateSupplyItems(orders) {
  const map = new Map();
  for (const order of Array.isArray(orders) ? orders : []) {
    const name = order?.productName || order?.article || "—";
    const barcode = order?.barcode || "—";
    const article = order?.article || "—";
    const nmId = order?.nmId || "—";
    const imageUrl = order?.imageUrl || "";
    const key = `${name}||${barcode}||${article}||${nmId}`;
    const rawQty = Number(order?.quantity ?? 1);
    const qty = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : 1;
    const entry = map.get(key) || { name, barcode, article, nmId, imageUrl, count: 0 };
    if (!entry.imageUrl && imageUrl) entry.imageUrl = imageUrl;
    entry.count += qty;
    map.set(key, entry);
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

function normalizeEmployeeOrder(order) {
  return {
    ...order,
    scanPassed: Boolean(order?.scanPassedAt),
    labelScanPassed: Boolean(order?.labelScanPassedAt),
  };
}

function getEmployeeItemKey(item) {
  if (!item) return "";
  return [
    item.article || "",
    item.barcode || "",
    item.nmId == null ? "" : String(item.nmId),
    item.productName || "",
  ].join("||");
}

function patchEmployeeSupplyWorkflowState(supply, sessionData, workflowData) {
  if (!supply) return supply;
  const nextCurrentStage = workflowData?.currentStage || supply.currentStage || "";
  const nextCanWork =
    nextCurrentStage === "packing" ||
    Boolean(sessionData?.startedAt && !sessionData?.finishedAt);
  return {
    ...supply,
    session: sessionData || supply.session || null,
    workflowMode: workflowData?.workflowMode || supply.workflowMode,
    workflowStage: workflowData?.workflowStage || supply.workflowStage,
    currentStage: nextCurrentStage || supply.currentStage,
    productPickingRequired:
      workflowData?.productPickingRequired ?? supply.productPickingRequired,
    productPickingActive:
      workflowData?.productPickingActive ?? supply.productPickingActive,
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
    .replace(/P/g, "Р")
    .replace(/K/g, "К");
}

function parsePickCellSortValue(value) {
  const normalized = normalizePickCellName(value);
  if (!normalized) {
    return { known: false, rack: Number.MAX_SAFE_INTEGER, shelf: Number.MAX_SAFE_INTEGER, box: Number.MAX_SAFE_INTEGER, tail: "", raw: "" };
  }
  const match = normalized.match(/^С(\d+)П(\d+)(?:К(\d+))?(.*)$/u);
  if (match) {
    return {
      known: true,
      rack: Number(match[1]),
      shelf: Number(match[2]),
      box: match[3] ? Number(match[3]) : -1,
      tail: match[4] || "",
      raw: normalized,
    };
  }
  return {
    known: false,
    rack: Number.MAX_SAFE_INTEGER,
    shelf: Number.MAX_SAFE_INTEGER,
    box: Number.MAX_SAFE_INTEGER,
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
  if (a.box !== b.box) return a.box - b.box;
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
    return sortEmployeePickItems((Array.isArray(items) ? items : []).filter((item) => Number(item?.id) !== Number(updatedItem.id)));
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

function pickOrders(orders, sortDir, count) {
  const sorted = [...orders].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (sortDir === "newest") sorted.reverse();
  if (!sorted.length) {
    return { selected: [], available: 0, warehouseId: null, cargoType: null };
  }
  const base = sorted[0];
  const filtered = sorted.filter((o) => {
    const sameWarehouse = base.warehouseId == null || o.warehouseId === base.warehouseId;
    const sameCargo = base.cargoType == null || o.cargoType === base.cargoType;
    return sameWarehouse && sameCargo;
  });
  return {
    selected: filtered.slice(0, count),
    available: filtered.length,
    warehouseId: base.warehouseId ?? null,
    cargoType: base.cargoType ?? null,
  };
}

function sortOrders(list, sortDir) {
  const sorted = [...list].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (sortDir === "newest") sorted.reverse();
  return sorted;
}

function matchesGroup(order, group) {
  if (group.warehouseId != null && order.warehouseId !== group.warehouseId) return false;
  if (group.cargoType != null && order.cargoType !== group.cargoType) return false;
  return true;
}

function buildArticleSelection(rows, articleMap) {
  const seen = new Set();
  const usableRows = [];
  for (const row of rows) {
    if (!row.article) continue;
    if (seen.has(row.article)) continue;
    seen.add(row.article);
    usableRows.push(row);
  }
  let group = { warehouseId: null, cargoType: null };

  for (const row of usableRows) {
    const entry = articleMap.get(row.article);
    if (!entry || entry.orders.length === 0) continue;
    const sorted = sortOrders(entry.orders, row.sortDir);
    const first = sorted[0];
    if (first) {
      group = {
        warehouseId: first.warehouseId ?? null,
        cargoType: first.cargoType ?? null,
      };
      break;
    }
  }

  const availableByArticle = new Map();
  for (const [article, entry] of articleMap.entries()) {
    const filtered = entry.orders.filter((order) => matchesGroup(order, group));
    availableByArticle.set(article, filtered.length);
  }

  const selected = [];
  for (const row of usableRows) {
    const entry = articleMap.get(row.article);
    if (!entry) continue;
    const filtered = entry.orders.filter((order) => matchesGroup(order, group));
    const sorted = sortOrders(filtered, row.sortDir);
    const countRaw = Number(row.count) || 0;
    const count = Math.max(0, Math.min(countRaw, sorted.length));
    selected.push(...sorted.slice(0, count));
  }

  const selectedIds = new Set();
  const unique = [];
  for (const order of selected) {
    const id = order.id;
    if (selectedIds.has(id)) continue;
    selectedIds.add(id);
    unique.push(order);
  }

  return {
    selected: unique,
    availableByArticle,
    warehouseId: group.warehouseId ?? null,
    cargoType: group.cargoType ?? null,
  };
}

const ROUTE_KEYS = [
  "store",
  "tab",
  "settingsTab",
  "supply",
  "supplyTab",
  "statsUser",
  "newItems",
  "newItemsTab",
  "create",
  "esupply",
  "eorder",
];
const ADMIN_TAB_VALUES = new Set(["new", "assembling", "fbs_stock", "employees", "settings"]);
const SETTINGS_TAB_VALUES = new Set(["errors"]);
const SUPPLY_TAB_VALUES = new Set(["orders", "items", "settings"]);
const NEW_ITEMS_TAB_VALUES = new Set(["current", "all"]);

function readRouteParams() {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search || "");
}

function isRouteFlagEnabled(value) {
  return String(value || "") === "1";
}

function getRouteEnum(value, allowed, fallback) {
  const normalized = String(value || "").trim();
  return allowed.has(normalized) ? normalized : fallback;
}

function getRoutePositiveInt(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getRouteId(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
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

function displayUserName(user) {
  return user?.fullName || `${user?.surname || ""} ${user?.name || ""}`.trim() || user?.login || "—";
}

function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [loginSurname, setLoginSurname] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [storeOptions, setStoreOptions] = useState([]);
  const [storeId, setStoreId] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem("wb_store_id") || "";
  });

  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState("");
  const [userTab, setUserTab] = useState("admins");
  const [userDirectory, setUserDirectory] = useState([]);
  const [userDirectoryLoading, setUserDirectoryLoading] = useState(false);
  const [userDirectoryError, setUserDirectoryError] = useState("");
  const [createExternalUserId, setCreateExternalUserId] = useState("");
  const [userActionBusy, setUserActionBusy] = useState(false);
  const [userActionError, setUserActionError] = useState("");
  const [editUser, setEditUser] = useState(null);
  const [editRole, setEditRole] = useState("employee");

  const [tab, setTab] = useState("new");
  const [adminSettingsTab, setAdminSettingsTab] = useState("errors");
  const [newOrders, setNewOrders] = useState([]);
  const [supplies, setSupplies] = useState([]);
  const [fbsStockItems, setFbsStockItems] = useState([]);
  const [fbsStockLoading, setFbsStockLoading] = useState(false);
  const [fbsStockError, setFbsStockError] = useState("");
  const [fbsStockWarehouseName, setFbsStockWarehouseName] = useState("Ижевск FBS");
  const [fbsStockTotals, setFbsStockTotals] = useState({ all: 0, ok: 0, shortage: 0, errors: 0 });
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
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);

  const [selectedSupply, setSelectedSupply] = useState(null);
  const [supplyOrders, setSupplyOrders] = useState([]);
  const [supplyLoading, setSupplyLoading] = useState(false);
  const [supplyError, setSupplyError] = useState("");
  const [supplyTab, setSupplyTab] = useState("orders");
  const [supplySettings, setSupplySettings] = useState(null);
  const [supplySettingsLoading, setSupplySettingsLoading] = useState(false);
  const [supplySettingsError, setSupplySettingsError] = useState("");
  const [supplySettingsNotice, setSupplySettingsNotice] = useState("");
  // WB re-sync feature: "idle" | "checking" | "applying"; syncDiff holds the preview.
  const [syncStatus, setSyncStatus] = useState("idle");
  const [syncDiff, setSyncDiff] = useState(null);
  const [syncError, setSyncError] = useState("");
  const [supplyAccessMode, setSupplyAccessMode] = useState("hidden");
  const [supplyAccessUsers, setSupplyAccessUsers] = useState([]);
  const [supplyEmployees, setSupplyEmployees] = useState([]);
  const [supplyProgress, setSupplyProgress] = useState([]);
  const [supplyTotals, setSupplyTotals] = useState({ total: 0, collected: 0, remaining: 0 });
  const [supplyEmployeeQuery, setSupplyEmployeeQuery] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [labelsBusy, setLabelsBusy] = useState(false);
  const [scanIssues, setScanIssues] = useState([]);
  const [scanIssuesLoading, setScanIssuesLoading] = useState(false);
  const [scanIssuesError, setScanIssuesError] = useState("");
  const [scanIssueActionBusyId, setScanIssueActionBusyId] = useState(null);

  const [newItemsOpen, setNewItemsOpen] = useState(false);
  const [newItemsTab, setNewItemsTab] = useState("current");
  const [newOrdersByStore, setNewOrdersByStore] = useState([]);
  const [newItemsAllLoading, setNewItemsAllLoading] = useState(false);
  const [newItemsAllError, setNewItemsAllError] = useState("");
  const [newItemsAllUpdatedAt, setNewItemsAllUpdatedAt] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createMode, setCreateMode] = useState("count");
  const [createCount, setCreateCount] = useState(50);
  const [createSort, setCreateSort] = useState("newest");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createSuccess, setCreateSuccess] = useState("");
  const [createWarning, setCreateWarning] = useState("");
  const [page, setPage] = useState(1);
  const rowIdRef = useRef(1);
  const liveStateRef = useRef({
    isAdmin: false,
    isEmployee: false,
    tab: "new",
    createOpen: false,
    selectedSupply: null,
    supplyTab: "orders",
    employeeSelectedSupply: null,
    employeeSelectedItem: null,
  });
  const liveTimerRef = useRef(null);
  const [articleRows, setArticleRows] = useState(() => [
    { id: rowIdRef.current++, article: "", count: 1, sortDir: "newest" },
  ]);

  const [employeeSupplies, setEmployeeSupplies] = useState([]);
  const [employeeSuppliesLoading, setEmployeeSuppliesLoading] = useState(false);
  const [employeeSuppliesError, setEmployeeSuppliesError] = useState("");
  const [employeeSelectedSupply, setEmployeeSelectedSupply] = useState(null);
  const [employeeItems, setEmployeeItems] = useState([]);
  const [employeeItemsLoading, setEmployeeItemsLoading] = useState(false);
  const [employeeItemsError, setEmployeeItemsError] = useState("");
  const [employeeSelectedItem, setEmployeeSelectedItem] = useState(null);
  const [employeeOrders, setEmployeeOrders] = useState([]);
  const [employeeOrdersLoading, setEmployeeOrdersLoading] = useState(false);
  const [employeeOrdersError, setEmployeeOrdersError] = useState("");
  const [employeeSelectedOrder, setEmployeeSelectedOrder] = useState(null);
  const [employeeCollectError, setEmployeeCollectError] = useState("");
  const [employeePickItems, setEmployeePickItems] = useState([]);
  const [employeePickItemsLoading, setEmployeePickItemsLoading] = useState(false);
  const [employeePickItemsError, setEmployeePickItemsError] = useState("");
  const employeePickScanInputRef = useRef(null);
  const employeePickScanTimerRef = useRef(null);
  const [employeePickScanValue, setEmployeePickScanValue] = useState("");
  const [employeePickScanBusy, setEmployeePickScanBusy] = useState(false);
  const [employeePickScanError, setEmployeePickScanError] = useState("");
  const [employeePickFinishBusy, setEmployeePickFinishBusy] = useState(false);
  const [employeePickFinishError, setEmployeePickFinishError] = useState("");
  const employeeLookupInputRef = useRef(null);
  const employeeLookupTimerRef = useRef(null);
  const pendingEmployeeOrderRef = useRef(null);
  const employeeSelectedItemRef = useRef(null);
  const employeeSelectedOrderRef = useRef(null);
  const [employeeLookupValue, setEmployeeLookupValue] = useState("");
  const [employeeLookupBusy, setEmployeeLookupBusy] = useState(false);
  const [employeeLookupError, setEmployeeLookupError] = useState("");
  const scanInputRef = useRef(null);
  const scanTimerRef = useRef(null);
  const [scanValue, setScanValue] = useState("");
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState("");
  const labelScanInputRef = useRef(null);
  const labelScanTimerRef = useRef(null);
  const [labelScanValue, setLabelScanValue] = useState("");
  const [labelScanBusy, setLabelScanBusy] = useState(false);
  const [labelScanError, setLabelScanError] = useState("");
  const [labelOpened, setLabelOpened] = useState(false);
  const [employeeSupplySession, setEmployeeSupplySession] = useState(null);
  const [employeeSupplySessionLoading, setEmployeeSupplySessionLoading] = useState(false);
  const [employeeSupplySessionError, setEmployeeSupplySessionError] = useState("");
  const [employeeStartBusy, setEmployeeStartBusy] = useState(false);
  const [employeeStartError, setEmployeeStartError] = useState("");
  const [employeeFlowNotice, setEmployeeFlowNotice] = useState("");
  const [employeeFlowWarning, setEmployeeFlowWarning] = useState("");
  const [employeeIssueOpen, setEmployeeIssueOpen] = useState(false);
  const [employeeIssueValue, setEmployeeIssueValue] = useState("");
  const [employeeIssueBusy, setEmployeeIssueBusy] = useState(false);
  const [employeeIssueError, setEmployeeIssueError] = useState("");
  const employeeIssueInputRef = useRef(null);
  const employeeIssueTimerRef = useRef(null);
  const [employeePickIssueOpen, setEmployeePickIssueOpen] = useState(false);
  const [employeePickIssueValue, setEmployeePickIssueValue] = useState("");
  const [employeePickIssueItemId, setEmployeePickIssueItemId] = useState("");
  const [employeePickIssueBusy, setEmployeePickIssueBusy] = useState(false);
  const [employeePickIssueError, setEmployeePickIssueError] = useState("");
  const [employeePickManualBusyId, setEmployeePickManualBusyId] = useState(null);
  const employeePickIssueInputRef = useRef(null);
  const employeePickIssueTimerRef = useRef(null);
  const employeePickFeedbackAudioRef = useRef(null);
  const employeePickFocusGuardRef = useRef({ canFocus: false });
  const employeeLiveRefreshBlockedUntilRef = useRef(0);
  const employeePickListBodyRef = useRef(null);
  const employeePickScrollRestoreRef = useRef(null);
  const routeApplyingRef = useRef(false);
  const routeInitializedRef = useRef(false);
  const fbsStockPollRef = useRef(null);
  const pendingAdminSupplyIdRef = useRef("");
  const pendingAdminSupplyTabRef = useRef("");
  const pendingStatsUserIdRef = useRef(null);
  const pendingEmployeeSupplyIdRef = useRef("");
  const pendingEmployeeOrderIdRef = useRef(null);
  const [employeeStatsUser, setEmployeeStatsUser] = useState(null);
  const [employeeStatsLoading, setEmployeeStatsLoading] = useState(false);
  const [employeeStatsError, setEmployeeStatsError] = useState("");
  const [employeeStatsData, setEmployeeStatsData] = useState(null);
  const [employeeStatsRangeKey, setEmployeeStatsRangeKey] = useState("7d");
  const [employeeStatsCustomFrom, setEmployeeStatsCustomFrom] = useState(() => shiftDateString(getMoscowDateString(), -6));
  const [employeeStatsCustomTo, setEmployeeStatsCustomTo] = useState(() => getMoscowDateString());

  const isAdmin = currentUser?.role === "admin";
  const isSuper = currentUser?.role === "super_admin";
  const isEmployee = currentUser?.role === "employee";
  const isCollectorEmployee =
    isEmployee && normalizeEmployeePosition(currentUser?.position) === EMPLOYEE_POSITION_COLLECTOR;
  const isPackerEmployee = isEmployee && !isCollectorEmployee;
  const usersRoleFilter = isSuper ? (userTab === "admins" ? "admin" : "employee") : "employee";
  const openScanIssueCount = scanIssues.length;
  const fbsStockAlertCount = Number(fbsStockTotals.shortage || 0) + Number(fbsStockTotals.errors || 0);
  const stockProblemsAlertCount =
    Number(stockProblems.negativeShelves?.length || 0) +
    Number(stockProblems.negativeEmployees?.length || 0) +
    Number(stockProblems.leftoverEmployees?.length || 0);
  const filteredSupplyEmployees = useMemo(() => {
    const query = supplyEmployeeQuery.trim().toLowerCase();
    if (!query) return supplyEmployees;
    return supplyEmployees.filter((user) => {
      const fullName = `${user.surname || ""} ${user.name || ""}`.toLowerCase();
      return fullName.includes(query);
    });
  }, [supplyEmployees, supplyEmployeeQuery]);

  const handleAuthError = (err) => {
    if (err?.status === 401) {
      setCurrentUser(null);
      setAuthChecked(true);
      return true;
    }
    return false;
  };

  const storeHeader = useMemo(() => {
    return storeId ? { "X-Store-Id": storeId } : {};
  }, [storeId]);

  const adminFetch = (url, options = {}) => {
    return fetchJson(url, {
      ...options,
      headers: { ...storeHeader, ...(options.headers || {}) },
    });
  };

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

  const applyRouteFromUrl = useCallback(() => {
    if (typeof window === "undefined") return;
    if (!currentUser) return;

    const params = readRouteParams();
    routeApplyingRef.current = true;

    if (isAdmin) {
      const nextStore = getRouteId(params.get("store"));
      if (nextStore && nextStore !== storeId) {
        setStoreId(nextStore);
      }

      const nextTab = getRouteEnum(params.get("tab"), ADMIN_TAB_VALUES, "new");
      const nextSettingsTab = getRouteEnum(params.get("settingsTab"), SETTINGS_TAB_VALUES, "errors");
      const nextCreateOpen = isRouteFlagEnabled(params.get("create"));
      const nextNewItemsOpen = isRouteFlagEnabled(params.get("newItems"));
      const nextNewItemsTab = getRouteEnum(params.get("newItemsTab"), NEW_ITEMS_TAB_VALUES, "current");
      const nextSupplyId = getRouteId(params.get("supply"));
      const nextSupplyTab = getRouteEnum(params.get("supplyTab"), SUPPLY_TAB_VALUES, "orders");
      const nextStatsUserId = getRoutePositiveInt(params.get("statsUser"));

      setTab(nextTab);
      setAdminSettingsTab(nextSettingsTab);
      setCreateOpen(nextCreateOpen);
      setNewItemsOpen(nextNewItemsOpen);
      setNewItemsTab(nextNewItemsTab);

      if (nextSupplyId) {
        const matchedSupply = supplies.find((item) => item.id === nextSupplyId) || null;
        pendingAdminSupplyIdRef.current = matchedSupply ? "" : nextSupplyId;
        pendingAdminSupplyTabRef.current = nextSupplyTab;
        setSelectedSupply(matchedSupply);
        if (matchedSupply) {
          setSupplyTab(nextSupplyTab);
          pendingAdminSupplyTabRef.current = "";
        }
      } else {
        pendingAdminSupplyIdRef.current = "";
        pendingAdminSupplyTabRef.current = "";
        setSelectedSupply(null);
      }

      if (nextStatsUserId) {
        const matchedUser = users.find((item) => Number(item.id) === Number(nextStatsUserId)) || null;
        pendingStatsUserIdRef.current = matchedUser ? null : nextStatsUserId;
        if (matchedUser) {
          setEmployeeStatsUser(matchedUser);
        }
      } else {
        pendingStatsUserIdRef.current = null;
        setEmployeeStatsUser(null);
      }
    } else if (isPackerEmployee) {
      const nextSupplyId = getRouteId(params.get("esupply"));
      const nextOrderId = getRoutePositiveInt(params.get("eorder"));

      if (nextSupplyId) {
        const matchedSupply = employeeSupplies.find((item) => item.id === nextSupplyId) || null;
        pendingEmployeeSupplyIdRef.current = matchedSupply ? "" : nextSupplyId;
        setEmployeeSelectedSupply(matchedSupply);

        if (nextOrderId) {
          pendingEmployeeOrderIdRef.current = nextOrderId;
          const matchedOrder = employeeOrders.find((item) => Number(item.id) === Number(nextOrderId)) || null;
          if (matchedOrder) {
            setEmployeeSelectedOrder(matchedOrder);
            pendingEmployeeOrderIdRef.current = null;
          }
        } else {
          pendingEmployeeOrderIdRef.current = null;
          setEmployeeSelectedOrder(null);
        }
      } else {
        pendingEmployeeSupplyIdRef.current = "";
        pendingEmployeeOrderIdRef.current = null;
        setEmployeeSelectedSupply(null);
        setEmployeeSelectedOrder(null);
      }
    }

    window.setTimeout(() => {
      routeApplyingRef.current = false;
    }, 0);
  }, [
    currentUser,
    isAdmin,
    isPackerEmployee,
    storeId,
    supplies,
    users,
    employeeSupplies,
    employeeOrders,
  ]);

  const updateSupplyList = (supplyId, patch) => {
    if (!supplyId) return;
    setSupplies((prev) => {
      let changed = false;
      const next = prev.map((item) => {
        if (item.id !== supplyId) return item;
        let updated = item;
        for (const [key, value] of Object.entries(patch || {})) {
          if (value === undefined) continue;
          if (updated[key] !== value) {
            if (updated === item) updated = { ...item };
            updated[key] = value;
            changed = true;
          }
        }
        return updated;
      });
      return changed ? next : prev;
    });
  };

  useEffect(() => {
    let active = true;
    fetchJson(`${API_BASE}/auth/me`)
      .then((data) => {
        if (!active) return;
        setCurrentUser(data?.user || null);
        setAuthChecked(true);
      })
      .catch((err) => {
        if (!active) return;
        if (err?.status === 401) {
          setCurrentUser(null);
          setAuthChecked(true);
          return;
        }
        setLoginError("Не удалось проверить авторизацию.");
        setAuthChecked(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!authChecked || !currentUser) {
      routeInitializedRef.current = false;
      return;
    }
    if (!routeInitializedRef.current) {
      routeInitializedRef.current = true;
      applyRouteFromUrl();
    }
    const onPopState = () => {
      applyRouteFromUrl();
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, [authChecked, currentUser, applyRouteFromUrl]);

  useEffect(() => {
    if (!authChecked || !currentUser) return;
    if (routeApplyingRef.current) return;
    if (typeof window === "undefined") return;

    const params = readRouteParams();
    ROUTE_KEYS.forEach((key) => params.delete(key));

    if (isAdmin) {
      if (storeId) params.set("store", storeId);
      params.set("tab", tab);
      if (tab === "settings") {
        params.set("settingsTab", adminSettingsTab);
      }
      if (createOpen) {
        params.set("create", "1");
      }
      if (tab === "new" && newItemsOpen) {
        params.set("newItems", "1");
        params.set("newItemsTab", newItemsTab);
      }
      if (selectedSupply?.id) {
        params.set("supply", String(selectedSupply.id));
        params.set("supplyTab", supplyTab);
      }
      if (employeeStatsUser?.id) {
        params.set("statsUser", String(employeeStatsUser.id));
      }
    } else if (isPackerEmployee) {
      if (employeeSelectedSupply?.id) {
        params.set("esupply", String(employeeSelectedSupply.id));
      }
      if (employeeSelectedOrder?.id) {
        params.set("eorder", String(employeeSelectedOrder.id));
      }
    }

    const query = params.toString();
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash || ""}`;
    const currentUrl = `${window.location.pathname}${window.location.search || ""}${window.location.hash || ""}`;
    if (nextUrl === currentUrl) return;
    window.history.pushState({}, "", nextUrl);
  }, [
    authChecked,
    currentUser,
    isAdmin,
    isPackerEmployee,
    storeId,
    tab,
    adminSettingsTab,
    createOpen,
    newItemsOpen,
    newItemsTab,
    selectedSupply?.id,
    supplyTab,
    employeeStatsUser?.id,
    employeeSelectedSupply?.id,
    employeeSelectedOrder?.id,
  ]);

  useEffect(() => {
    if (!isAdmin) {
      pendingAdminSupplyIdRef.current = "";
      pendingAdminSupplyTabRef.current = "";
      return;
    }
    const pendingSupplyId = pendingAdminSupplyIdRef.current;
    if (!pendingSupplyId) return;
    const matchedSupply = supplies.find((item) => item.id === pendingSupplyId) || null;
    if (!matchedSupply) return;
    pendingAdminSupplyIdRef.current = "";
    setSelectedSupply(matchedSupply);
    if (pendingAdminSupplyTabRef.current) {
      setSupplyTab(pendingAdminSupplyTabRef.current);
      pendingAdminSupplyTabRef.current = "";
    }
  }, [isAdmin, supplies]);

  useEffect(() => {
    if (!isAdmin) {
      pendingStatsUserIdRef.current = null;
      return;
    }
    const pendingUserId = Number(pendingStatsUserIdRef.current || 0);
    if (!pendingUserId) return;
    const matchedUser = users.find((item) => Number(item.id) === pendingUserId) || null;
    if (!matchedUser) return;
    pendingStatsUserIdRef.current = null;
    setEmployeeStatsUser(matchedUser);
  }, [isAdmin, users]);

  useEffect(() => {
    if (!isPackerEmployee) {
      pendingEmployeeSupplyIdRef.current = "";
      pendingEmployeeOrderIdRef.current = null;
      return;
    }
    const pendingSupplyId = pendingEmployeeSupplyIdRef.current;
    if (!pendingSupplyId) return;
    const matchedSupply = employeeSupplies.find((item) => item.id === pendingSupplyId) || null;
    if (!matchedSupply) return;
    pendingEmployeeSupplyIdRef.current = "";
    setEmployeeSelectedSupply(matchedSupply);
  }, [isPackerEmployee, employeeSupplies]);

  useEffect(() => {
    if (!isPackerEmployee) {
      pendingEmployeeOrderIdRef.current = null;
      return;
    }
    const pendingOrderId = Number(pendingEmployeeOrderIdRef.current || 0);
    if (!pendingOrderId) return;
    const matchedOrder = employeeOrders.find((item) => Number(item.id) === pendingOrderId) || null;
    if (!matchedOrder) return;
    pendingEmployeeOrderIdRef.current = null;
    setEmployeeSelectedOrder(matchedOrder);
  }, [isPackerEmployee, employeeOrders]);

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
      window.localStorage.setItem("wb_store_id", storeId);
    }
  }, [storeId, isAdmin]);

  const handleLogin = async () => {
    setLoginError("");
    const login = loginSurname.trim();
    if (!login || !loginPassword) {
      setLoginError("Введите логин и пароль.");
      return;
    }
    try {
      setLoginBusy(true);
      const data = await fetchJson(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login, password: loginPassword }),
      });
      setCurrentUser(data?.user || null);
      setAuthChecked(true);
      setLoginPassword("");
    } catch (err) {
      setLoginError(err?.message || "Не удалось войти.");
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
  };

  const loadUsers = async () => {
    if (!currentUser) return;
    setUsersLoading(true);
    setUsersError("");
    try {
      const roleParam = isSuper ? `?role=${usersRoleFilter}` : "";
      const data = await fetchJson(`${API_BASE}/users${roleParam}`);
      setUsers(Array.isArray(data?.users) ? data.users : []);
    } catch (err) {
      if (handleAuthError(err)) return;
      setUsersError("Не удалось загрузить пользователей.");
    } finally {
      setUsersLoading(false);
    }
  };

  const loadUserDirectory = async () => {
    if (!currentUser) return;
    setUserDirectoryLoading(true);
    setUserDirectoryError("");
    try {
      const data = await fetchJson(`${API_BASE}/users/directory`);
      setUserDirectory(Array.isArray(data?.users) ? data.users : []);
    } catch (err) {
      if (handleAuthError(err)) return;
      setUserDirectoryError("Не удалось загрузить сотрудников из общей базы.");
    } finally {
      setUserDirectoryLoading(false);
    }
  };

  const handleCreateUser = async () => {
    setUserActionError("");
    const externalUserId = Number(createExternalUserId);
    if (!Number.isFinite(externalUserId) || externalUserId < 1) {
      setUserActionError("Выберите сотрудника из общей базы.");
      return;
    }
    try {
      setUserActionBusy(true);
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
      setUserActionError(err?.message || "Не удалось создать пользователя.");
    } finally {
      setUserActionBusy(false);
    }
  };

  const openEditUser = (user) => {
    setEditUser(user);
    setEditRole(user?.role || "employee");
    setUserActionError("");
  };

  const handleSaveUser = async () => {
    if (!editUser) return;
    setUserActionError("");
    if (!["admin", "employee"].includes(editRole)) {
      setUserActionError("Некорректная роль.");
      return;
    }
    try {
      setUserActionBusy(true);
      await fetchJson(`${API_BASE}/users/${editUser.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: editRole }),
      });
      setEditUser(null);
      await Promise.all([loadUsers(), loadUserDirectory()]);
    } catch (err) {
      if (handleAuthError(err)) return;
      setUserActionError(err?.message || "Не удалось сохранить пользователя.");
    } finally {
      setUserActionBusy(false);
    }
  };

  const handleDeleteUser = async (user) => {
    if (!user) return;
    if (!window.confirm(`Удалить пользователя ${user.fullName || `${user.surname} ${user.name}`.trim() || user.login}?`)) return;
    setUserActionError("");
    try {
      setUserActionBusy(true);
      await fetchJson(`${API_BASE}/users/${user.id}`, { method: "DELETE" });
      await Promise.all([loadUsers(), loadUserDirectory()]);
    } catch (err) {
      if (handleAuthError(err)) return;
      setUserActionError(err?.message || "Не удалось удалить пользователя.");
    } finally {
      setUserActionBusy(false);
    }
  };

  const openEmployeeStats = (user) => {
    if (!user) return;
    const today = getMoscowDateString();
    setEmployeeStatsUser(user);
    setEmployeeStatsError("");
    setEmployeeStatsData(null);
    setEmployeeStatsRangeKey("7d");
    setEmployeeStatsCustomFrom(shiftDateString(today, -6));
    setEmployeeStatsCustomTo(today);
  };

  const closeEmployeeStats = () => {
    setEmployeeStatsUser(null);
    setEmployeeStatsError("");
    setEmployeeStatsData(null);
  };

  const applyEmployeeCustomStatsRange = () => {
    if (!employeeStatsUser) return;
    if (!employeeStatsCustomFrom || !employeeStatsCustomTo || employeeStatsCustomFrom > employeeStatsCustomTo) {
      setEmployeeStatsError("Проверьте диапазон дат.");
      return;
    }
    loadEmployeeStats(employeeStatsUser, {
      rangeKey: "custom",
      customFrom: employeeStatsCustomFrom,
      customTo: employeeStatsCustomTo,
    });
  };

  const loadData = async ({ withNewOrders = true, withSupplies = true, silent = false } = {}) => {
    try {
      if (!silent) setError("");
      const [newData, supplyData] = await Promise.all([
        withNewOrders ? adminFetch(`${API_BASE}/new-orders`) : Promise.resolve(null),
        withSupplies ? adminFetch(`${API_BASE}/supplies`) : Promise.resolve(null),
      ]);
      if (newData) {
        setNewOrders(Array.isArray(newData.orders) ? newData.orders : []);
      }
      if (supplyData) {
        setSupplies(Array.isArray(supplyData.supplies) ? supplyData.supplies : []);
      }
      if (withNewOrders || withSupplies) {
        setLastUpdated(new Date());
      }
    } catch (err) {
      if (handleAuthError(err)) return;
      if (!silent) setError("Не удалось загрузить данные. Проверьте токен и доступ к API.");
    } finally {
      if (!silent) setBooting(false);
    }
  };

  const loadSupplyOrders = async (supply, { silent = false } = {}) => {
    if (!supply) return;
    if (!silent) {
      setSupplyLoading(true);
      setSupplyError("");
    }
    try {
      const data = await adminFetch(`${API_BASE}/supplies/${encodeURIComponent(supply.id)}/orders`);
      const orders = Array.isArray(data.orders) ? data.orders : [];
      const collected = orders.reduce((count, order) => count + (order?.collectedAt ? 1 : 0), 0);
      const totals = {
        total: orders.length,
        collected,
        remaining: Math.max(0, orders.length - collected),
      };
      setSupplyOrders(orders);
      setSupplyTotals(totals);
      updateSupplyList(supply.id, {
        orderCount: totals.total,
        collectedCount: totals.collected,
        remainingCount: totals.remaining,
      });
      return orders;
    } catch (err) {
      if (handleAuthError(err)) return [];
      if (!silent) {
        setSupplyOrders([]);
        setSupplyError("Не удалось загрузить заказы поставки.");
      }
      return [];
    } finally {
      if (!silent) setSupplyLoading(false);
    }
  };

  const loadSupplySettings = async (supply, { silent = false } = {}) => {
    if (!supply) return;
    if (!silent) {
      setSupplySettingsLoading(true);
      setSupplySettingsError("");
    }
    try {
      const data = await adminFetch(
        `${API_BASE}/supplies/${encodeURIComponent(supply.id)}/settings`
      );
      const accessUserIds = Array.isArray(data?.accessUserIds) ? data.accessUserIds : [];
      const totals = {
        total: Number(data?.totals?.total || 0),
        collected: Number(data?.totals?.collected || 0),
        remaining: Number(data?.totals?.remaining || 0),
      };
      setSupplySettings(data?.settings || null);
      setSupplyAccessMode(data?.settings?.accessMode || "hidden");
      setSupplyAccessUsers(accessUserIds);
      setSupplyEmployees(Array.isArray(data?.employees) ? data.employees : []);
      setSupplyProgress(Array.isArray(data?.progress) ? data.progress : []);
      setSupplyTotals(totals);
      updateSupplyList(supply.id, {
        accessMode: data?.settings?.accessMode,
        accessUserCount: accessUserIds.length,
        orderCount: totals.total,
        collectedCount: totals.collected,
        remainingCount: totals.remaining,
        name: data?.settings?.supplyName || supply.name,
        storeName: data?.settings?.storeName,
      });
    } catch (err) {
      if (handleAuthError(err)) return;
      if (!silent) {
        setSupplySettingsError("Не удалось загрузить настройки поставки.");
      }
    } finally {
      if (!silent) setSupplySettingsLoading(false);
    }
  };

  useEffect(() => {
    setSyncDiff(null);
    setSyncStatus("idle");
    setSyncError("");
  }, [selectedSupply?.id]);

  const handleCheckSupplySync = async () => {
    if (!selectedSupply) return;
    setSyncError("");
    setSyncDiff(null);
    setSyncStatus("checking");
    try {
      const data = await adminFetch(
        `${API_BASE}/supplies/${encodeURIComponent(selectedSupply.id)}/sync-preview`,
        { method: "POST" }
      );
      setSyncDiff(data);
      setSyncStatus("idle");
      if (data?.fetchOk === false) {
        setSyncError("Не удалось получить данные из Wildberries. Попробуйте ещё раз.");
      }
    } catch (err) {
      setSyncStatus("idle");
      setSyncError("Ошибка проверки. Попробуйте ещё раз.");
    }
  };

  const handleApplySupplySync = async () => {
    if (!selectedSupply) return;
    setSyncError("");
    setSyncStatus("applying");
    try {
      const res = await adminFetch(
        `${API_BASE}/supplies/${encodeURIComponent(selectedSupply.id)}/sync-apply`,
        { method: "POST" }
      );
      setSyncDiff(null);
      setSyncStatus("idle");
      const ignoredText = Number(res?.ignoredAddedCount || 0) > 0
        ? ` Новых заказов на WB не добавлено: ${Number(res.ignoredAddedCount)}.`
        : "";
      setSupplySettingsNotice(`Обычная синхронизация: убрано ${res?.removedCount || 0}.${ignoredText}`);
      await loadSupplySettings(selectedSupply, { silent: true });
    } catch (err) {
      setSyncStatus("idle");
      setSyncError("Не удалось применить изменения. Попробуйте ещё раз.");
    }
  };

  const handleApplyFullSupplySync = async () => {
    if (!selectedSupply) return;
    setSyncError("");
    setSyncStatus("fullApplying");
    try {
      const res = await adminFetch(
        `${API_BASE}/supplies/${encodeURIComponent(selectedSupply.id)}/sync-full-apply`,
        { method: "POST" }
      );
      setSyncDiff(null);
      setSyncStatus("idle");
      setSupplySettingsNotice(
        `Полная синхронизация: ${res?.afterCount || 0} заказов, +${res?.addedCount || 0} / −${res?.removedCount || 0}.`
      );
      await Promise.all([
        loadSupplySettings(selectedSupply, { silent: true }),
        loadSupplyOrders(selectedSupply, { silent: true }),
        loadData({ silent: true, withSupplies: true, withNewOrders: false }),
      ]);
    } catch (err) {
      setSyncStatus("idle");
      setSyncError(err?.message || "Не удалось выполнить полную синхронизацию.");
    }
  };

  const handleAccessModeChange = async (mode) => {
    if (!selectedSupply) return;
    setSupplyAccessMode(mode);
    setSettingsBusy(true);
    setSupplySettingsError("");
    setSupplySettingsNotice("");
    try {
      await adminFetch(`${API_BASE}/supplies/${encodeURIComponent(selectedSupply.id)}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessMode: mode }),
      });
      await loadSupplySettings(selectedSupply, { silent: true });
      setSupplySettingsNotice("Настройки сохранены.");
    } catch (err) {
      if (handleAuthError(err)) return;
      setSupplySettingsError(err?.message || "Не удалось сохранить настройки.");
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleEmployeeWorkflowModeChange = async (enabled) => {
    if (!selectedSupply) return;
    const nextMode = enabled ? "picking" : "legacy";
    setSettingsBusy(true);
    setSupplySettingsError("");
    setSupplySettingsNotice("");
    try {
      await adminFetch(`${API_BASE}/supplies/${encodeURIComponent(selectedSupply.id)}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeWorkflowMode: nextMode }),
      });
      await loadSupplySettings(selectedSupply, { silent: true });
      setSupplySettingsNotice(
        nextMode === "picking"
          ? "Включён новый метод: сначала сборка товара, потом упаковка заказов."
          : "Включён старый метод: упаковщики сразу переходят к сборке заказов."
      );
    } catch (err) {
      if (handleAuthError(err)) return;
      setSupplySettingsError(err?.message || "Не удалось переключить метод сборки.");
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleStockMethodChange = async (enabled) => {
    if (!selectedSupply) return;
    setSettingsBusy(true);
    setSupplySettingsError("");
    setSupplySettingsNotice("");
    try {
      await adminFetch(`${API_BASE}/supplies/${encodeURIComponent(selectedSupply.id)}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stockMethodEnabled: enabled }),
      });
      await loadSupplySettings(selectedSupply, { silent: true });
      setSupplySettingsNotice(
        enabled
          ? "Включён новый складской метод: при сканировании идут автоперемещение и списание."
          : "Включён старый складской метод: сборка идёт без работы с остатками."
      );
    } catch (err) {
      if (handleAuthError(err)) return;
      setSupplySettingsError(err?.message || "Не удалось переключить складской метод.");
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleSaveAccessUsers = async () => {
    if (!selectedSupply) return;
    setSettingsBusy(true);
    setSupplySettingsError("");
    setSupplySettingsNotice("");
    try {
      await adminFetch(`${API_BASE}/supplies/${encodeURIComponent(selectedSupply.id)}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: supplyAccessUsers }),
      });
      await loadSupplySettings(selectedSupply, { silent: true });
      setSupplySettingsNotice("Доступ сотрудников обновлён.");
    } catch (err) {
      if (handleAuthError(err)) return;
      setSupplySettingsError(err?.message || "Не удалось обновить доступ.");
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleSplitSupply = async (mode) => {
    if (!selectedSupply) return;
    setSettingsBusy(true);
    setSupplySettingsError("");
    setSupplySettingsNotice("");
    try {
      const path = mode === "redistribute" ? "redistribute" : "split";
      await adminFetch(`${API_BASE}/supplies/${encodeURIComponent(selectedSupply.id)}/${path}`, {
        method: "POST",
      });
      await Promise.all([
        loadSupplySettings(selectedSupply, { silent: true }),
        loadSupplyOrders(selectedSupply, { silent: true }),
      ]);
      setSupplySettingsNotice(mode === "redistribute" ? "Поставка перераспределена." : "Поставка распределена.");
    } catch (err) {
      if (handleAuthError(err)) return;
      setSupplySettingsError(err?.message || "Не удалось распределить поставку.");
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleStartProductPicking = async () => {
    if (!selectedSupply) return;
    setSettingsBusy(true);
    setSupplySettingsError("");
    setSupplySettingsNotice("");
    try {
      await adminFetch(`${API_BASE}/supplies/${encodeURIComponent(selectedSupply.id)}/product-picking/start`, {
        method: "POST",
      });
      await Promise.all([
        loadSupplySettings(selectedSupply, { silent: true }),
        loadSupplyOrders(selectedSupply, { silent: true }),
      ]);
      setSupplySettingsNotice("Сборка товара для упаковщиков запущена.");
    } catch (err) {
      if (handleAuthError(err)) return;
      setSupplySettingsError(err?.message || "Не удалось запустить сборку товара.");
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleResetAccess = async () => {
    if (!selectedSupply) return;
    setSettingsBusy(true);
    setSupplySettingsError("");
    setSupplySettingsNotice("");
    try {
      await adminFetch(`${API_BASE}/supplies/${encodeURIComponent(selectedSupply.id)}/reset-access`, {
        method: "POST",
      });
      await Promise.all([
        loadSupplySettings(selectedSupply, { silent: true }),
        loadSupplyOrders(selectedSupply, { silent: true }),
      ]);
      setSupplySettingsNotice("Поставка скрыта.");
    } catch (err) {
      if (handleAuthError(err)) return;
      setSupplySettingsError(err?.message || "Не удалось скрыть поставку.");
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleLoadLabels = async () => {
    if (!selectedSupply) return;
    setLabelsBusy(true);
    setSupplySettingsError("");
    setSupplySettingsNotice("");
    try {
      await adminFetch(`${API_BASE}/supplies/${encodeURIComponent(selectedSupply.id)}/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplyName: selectedSupply.name || null }),
      });
      await loadSupplySettings(selectedSupply, { silent: true });
      setSupplySettingsNotice("Загрузка этикеток запущена.");
    } catch (err) {
      if (handleAuthError(err)) return;
      setSupplySettingsError(err?.message || "Не удалось загрузить этикетки.");
    } finally {
      setLabelsBusy(false);
    }
  };

  const loadFbsStockCheck = async ({ force = false, silent = false, progressOnly = false } = {}) => {
    if (!isAdmin || !storeId) return;
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
      setFbsStockItems(items);
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
      if (!silent || !progressOnly) setFbsStockError(err?.message || "Не удалось загрузить проверку остатков ФБС.");
      setFbsStockRefreshing(false);
    } finally {
      if (!silent && !progressOnly) setFbsStockLoading(false);
    }
  };

  const loadStockProblems = async ({ silent = false } = {}) => {
    if (!isAdmin && !isSuper) return;
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
      if (!silent) setStockProblemsError(err?.message || "Не удалось загрузить проблемы остатков.");
    } finally {
      if (!silent) setStockProblemsLoading(false);
    }
  };

  const loadEmployeeSupplies = async ({ silent = false } = {}) => {
    if (!silent) {
      setEmployeeSuppliesLoading(true);
      setEmployeeSuppliesError("");
    }
    try {
      const data = await fetchJson(`${API_BASE}/employee/supplies`);
      const supplies = Array.isArray(data?.supplies) ? data.supplies : [];
      setEmployeeSupplies(supplies);
    } catch (err) {
      if (handleAuthError(err)) return;
      if (!silent) {
        setEmployeeSuppliesError(err?.message || "Не удалось загрузить поставки.");
      }
    } finally {
      if (!silent) setEmployeeSuppliesLoading(false);
    }
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
    employeeSupplySession?.workflow?.currentStage === "picking" &&
    !employeeSelectedItem &&
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

  const loadEmployeePickItems = async (supplyId, { silent = false } = {}) => {
    if (!supplyId) return [];
    if (!silent) {
      setEmployeePickItemsLoading(true);
      setEmployeePickItemsError("");
      setEmployeePickFinishError("");
    }
    try {
      const data = await fetchJson(`${API_BASE}/employee/supplies/${encodeURIComponent(supplyId)}/pick-items`);
      const items = Array.isArray(data?.items) ? data.items : [];
      const sortedItems = sortEmployeePickItems(items);
      rememberEmployeePickScroll();
      setEmployeePickItems(sortedItems);
      restoreEmployeePickScroll();
      if (data?.session) {
        setEmployeeSupplySession((prev) => (prev ? { ...prev, session: data.session } : prev));
      }
      return sortedItems;
    } catch (err) {
      if (handleAuthError(err)) return [];
      if (!silent) {
        setEmployeePickItemsError(err?.message || "Не удалось загрузить сборку товара.");
      }
      return [];
    } finally {
      if (!silent) setEmployeePickItemsLoading(false);
    }
  };

  const loadEmployeeItems = async (supplyId, { silent = false } = {}) => {
    if (!supplyId) return;
    if (!silent) {
      setEmployeeItemsLoading(true);
      setEmployeeItemsError("");
    }
    try {
      const data = await fetchJson(`${API_BASE}/employee/supplies/${encodeURIComponent(supplyId)}/items`);
      const items = Array.isArray(data?.items) ? data.items : [];
      setEmployeeItems(items);
      const currentItem = employeeSelectedItemRef.current;
      if (currentItem) {
        const matchedItem = items.find((item) => getEmployeeItemKey(item) === getEmployeeItemKey(currentItem)) || null;
        if (matchedItem) {
          setEmployeeSelectedItem((prev) =>
            prev && getEmployeeItemKey(prev) === getEmployeeItemKey(matchedItem) ? prev : matchedItem
          );
        } else {
          setEmployeeSelectedItem(null);
          setEmployeeSelectedOrder(null);
          setEmployeeOrders([]);
        }
      }
      return items;
    } catch (err) {
      if (handleAuthError(err)) return;
      if (!silent) {
        setEmployeeItemsError(err?.message || "Не удалось загрузить товары.");
      }
      return [];
    } finally {
      if (!silent) setEmployeeItemsLoading(false);
    }
  };

  const loadEmployeeOrders = async (supplyId, item, { silent = false } = {}) => {
    if (!supplyId || !item) return;
    if (!silent) {
      setEmployeeOrdersLoading(true);
      setEmployeeOrdersError("");
    }
    try {
      const params = new URLSearchParams();
      if (item.article) params.set("article", item.article);
      if (item.barcode) params.set("barcode", item.barcode);
      if (item.nmId) params.set("nmId", item.nmId);
      const qs = params.toString();
      const data = await fetchJson(
        `${API_BASE}/employee/supplies/${encodeURIComponent(supplyId)}/orders${qs ? `?${qs}` : ""}`
      );
      const orders = Array.isArray(data?.orders) ? data.orders : [];
      const normalizedOrders = orders.map(normalizeEmployeeOrder);
      setEmployeeOrders(normalizedOrders);
      const pendingOrder = pendingEmployeeOrderRef.current;
      if (pendingOrder?.supplyId === supplyId) {
        const matched = normalizedOrders.find((entry) => entry.id === pendingOrder.orderId) || pendingOrder.order;
        pendingEmployeeOrderRef.current = null;
        if (matched) {
          setEmployeeSelectedOrder(matched);
        }
      } else {
        const currentOrder = employeeSelectedOrderRef.current;
        if (currentOrder) {
          const matched = normalizedOrders.find((entry) => entry.id === currentOrder.id) || null;
          if (matched) {
            setEmployeeSelectedOrder(matched);
          }
        }
      }
      return normalizedOrders;
    } catch (err) {
      if (handleAuthError(err)) return;
      if (!silent) {
        setEmployeeOrdersError(err?.message || "Не удалось загрузить заказы.");
      }
      return [];
    } finally {
      if (!silent) setEmployeeOrdersLoading(false);
    }
  };

  const loadEmployeeSupplySession = async (supplyId, { silent = false } = {}) => {
    if (!supplyId) return null;
    if (!silent) {
      setEmployeeSupplySessionLoading(true);
      setEmployeeSupplySessionError("");
      setEmployeeStartError("");
    }
    try {
      const data = await fetchJson(`${API_BASE}/employee/supplies/${encodeURIComponent(supplyId)}/session`);
      setEmployeeSupplySession(data || null);
      return data || null;
    } catch (err) {
      if (handleAuthError(err)) return null;
      if (!silent) {
        setEmployeeSupplySessionError(err?.message || "Не удалось загрузить состояние поставки.");
      }
      return null;
    } finally {
      if (!silent) setEmployeeSupplySessionLoading(false);
    }
  };

  const handleEmployeeStart = async () => {
    if (!employeeSelectedSupply || employeeStartBusy) return;
    setEmployeeStartBusy(true);
    setEmployeeStartError("");
    setEmployeeFlowNotice("");
    setEmployeeFlowWarning("");
    try {
      const data = await fetchJson(`${API_BASE}/employee/supplies/${encodeURIComponent(employeeSelectedSupply.id)}/start`, {
        method: "POST",
      });
      suppressEmployeeLiveRefresh();
      const nextSession = data?.session || null;
      const nextWorkflow = data?.workflow || null;
      const currentStage = nextWorkflow?.currentStage || "";
      setEmployeeSupplySession((prev) => ({
        ...(prev || {}),
        supply: prev?.supply || {
          id: employeeSelectedSupply.id,
          name: employeeSelectedSupply.name || null,
          storeId: employeeSelectedSupply.storeId || null,
          storeName: employeeSelectedSupply.storeName || null,
          total: employeeSelectedSupply.total || 0,
          collected: employeeSelectedSupply.collected || 0,
          remaining: employeeSelectedSupply.remaining || 0,
        },
        session: nextSession,
        workflow: nextWorkflow,
        canStart: Boolean(nextWorkflow?.canStartPicking || nextWorkflow?.canStartPacking),
        canWork: currentStage === "packing",
        activeSession: prev?.activeSession || null,
      }));
      setEmployeeSelectedSupply((prev) =>
        prev && prev.id === employeeSelectedSupply.id
          ? patchEmployeeSupplyWorkflowState(prev, nextSession, nextWorkflow)
          : prev
      );
      setEmployeeSupplies((prev) =>
        prev.map((supply) =>
          supply.id === employeeSelectedSupply.id
            ? patchEmployeeSupplyWorkflowState(supply, nextSession, nextWorkflow)
            : supply
        )
      );
      if (currentStage === "picking") {
        setEmployeePickItems(sortEmployeePickItems(Array.isArray(data?.pickItems) ? data.pickItems : []));
        setEmployeeFlowNotice("Сборка товара начата. Соберите товары с полок перед упаковкой заказов.");
        queueEmployeePickScanFocus();
      } else {
        setEmployeePickItems([]);
        setEmployeeFlowNotice("Сборка заказов начата. Можно приступать к упаковке.");
      }
    } catch (err) {
      if (handleAuthError(err)) return;
      setEmployeeStartError(err?.message || "Не удалось начать сборку.");
    } finally {
      setEmployeeStartBusy(false);
    }
  };

  const handleEmployeePickScan = async (value) => {
    if (!employeeSelectedSupply || employeePickScanBusy) return;
    const barcode = value.trim();
    if (!barcode) return;
    setEmployeePickScanBusy(true);
    setEmployeePickScanError("");
    setEmployeeFlowWarning("");
    setEmployeePickIssueError("");
    try {
      const data = await fetchJson(
        `${API_BASE}/employee/supplies/${encodeURIComponent(employeeSelectedSupply.id)}/pick-scan`,
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
        setEmployeeSupplySession((prev) => (prev ? { ...prev, session: data.session } : prev));
        setEmployeeSelectedSupply((prev) =>
          prev && prev.id === employeeSelectedSupply.id ? { ...prev, session: data.session } : prev
        );
        setEmployeeSupplies((prev) =>
          prev.map((supply) =>
            supply.id === employeeSelectedSupply.id ? { ...supply, session: data.session } : supply
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
    if (!employeeSelectedSupply || employeePickFinishBusy) return;
    setEmployeePickFinishBusy(true);
    setEmployeePickFinishError("");
    setEmployeeFlowWarning("");
    try {
      await fetchJson(`${API_BASE}/employee/supplies/${encodeURIComponent(employeeSelectedSupply.id)}/pick-finish`, {
        method: "POST",
      });
      suppressEmployeeLiveRefresh();
      setEmployeePickItems([]);
      await Promise.all([
        loadEmployeeSupplySession(employeeSelectedSupply.id, { silent: true }),
        loadEmployeeSupplies({ silent: true }),
      ]);
      setEmployeeFlowNotice("Сборка товара завершена. Теперь можно начать упаковку заказов.");
    } catch (err) {
      if (handleAuthError(err)) return;
      setEmployeePickFinishError(err?.message || "Не удалось завершить сборку товара.");
    } finally {
      setEmployeePickFinishBusy(false);
    }
  };

  const loadScanIssues = async ({ silent = false } = {}) => {
    if (!silent) {
      setScanIssuesLoading(true);
      setScanIssuesError("");
    }
    try {
      const data = await adminFetch(`${API_BASE}/settings/scan-issues`);
      setScanIssues(Array.isArray(data?.issues) ? data.issues : []);
      return Array.isArray(data?.issues) ? data.issues : [];
    } catch (err) {
      if (handleAuthError(err)) return [];
      if (!silent) {
        setScanIssuesError(err?.message || "Не удалось загрузить ошибки сотрудников.");
      }
      return [];
    } finally {
      if (!silent) setScanIssuesLoading(false);
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
      setScanIssuesError(err?.message || "Не удалось отметить ошибку как решённую.");
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
      setScanIssuesError(err?.message || "Не удалось выполнить фикс.");
    } finally {
      setScanIssueActionBusyId(null);
    }
  };

  const loadEmployeeStats = async (user, { rangeKey = employeeStatsRangeKey, customFrom = employeeStatsCustomFrom, customTo = employeeStatsCustomTo } = {}) => {
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
      setEmployeeStatsError(err?.message || "Не удалось загрузить статистику сотрудника.");
    } finally {
      setEmployeeStatsLoading(false);
    }
  };

  const handleEmployeeLookupScan = async (value) => {
    if (!employeeSelectedSupply) return;
    if (!employeeSupplySession?.canWork) return;
    if (employeeLookupBusy) return;
    const barcode = value.trim();
    if (!barcode) return;
    setEmployeeLookupBusy(true);
    setEmployeeLookupError("");
    setEmployeeFlowWarning("");
    try {
      const data = await fetchJson(
        `${API_BASE}/employee/supplies/${encodeURIComponent(employeeSelectedSupply.id)}/scan-order`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ barcode }),
        }
      );
      const item = data?.item
        ? {
            productName: data.item.productName || "—",
            barcode: data.item.barcode || "",
            article: data.item.article || "",
            nmId: data.item.nmId || "",
          }
        : null;
      const order = data?.order ? normalizeEmployeeOrder(data.order) : null;
      if (!item || !order) {
        throw new Error("Не удалось открыть заказ");
      }
      pendingEmployeeOrderRef.current = {
        supplyId: employeeSelectedSupply.id,
        orderId: order.id,
        order,
      };
      setEmployeeLookupValue("");
      setEmployeeLookupError("");
      setEmployeeFlowWarning(data?.warning || "");
      setEmployeeSelectedItem(item);
      setEmployeeSelectedOrder(order);
      await Promise.all([
        loadEmployeeItems(employeeSelectedSupply.id, { silent: true }),
        loadEmployeeSupplies({ silent: true }),
      ]);
    } catch (err) {
      pendingEmployeeOrderRef.current = null;
      setEmployeeLookupError(err?.message || "Товар не найден в этой поставке");
      setEmployeeLookupValue("");
      if (employeeLookupInputRef.current) {
        employeeLookupInputRef.current.focus();
      }
    } finally {
      setEmployeeLookupBusy(false);
    }
  };

  const handleCollectOrder = (order) => {
    if (!employeeSelectedSupply || !order) return;
    if (!order.scanPassed) {
      setEmployeeCollectError("Безошибочная сборка не пройдена.");
      return;
    }
    if (!order.stickerUrl) {
      setEmployeeCollectError("Этикетка не загружена.");
      return;
    }
    setEmployeeCollectError("");
    window.open(order.stickerUrl, "_blank", "noopener");
    setLabelOpened(true);
  };

  const handleEmployeeIssueSubmit = async (order, value) => {
    if (!employeeSelectedSupply || !order) return;
    if (!employeeSupplySession?.canWork) return;
    if (employeeIssueBusy) return;
    const barcode = value.trim();
    if (!barcode) return;
    setEmployeeIssueBusy(true);
    setEmployeeIssueError("");
    setEmployeeFlowWarning("");
    try {
      await fetchJson(
        `${API_BASE}/employee/supplies/${encodeURIComponent(employeeSelectedSupply.id)}/orders/${order.id}/scan-issue`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ barcode }),
        }
      );
      suppressEmployeeLiveRefresh();
      setEmployeeIssueOpen(false);
      setEmployeeIssueValue("");
      setEmployeeIssueError("");
      setEmployeeFlowNotice("Ошибка отправлена админу. Ожидайте фикс или продолжайте после подтверждения.");
    } catch (err) {
      if (handleAuthError(err)) return;
      setEmployeeIssueError(err?.message || "Не удалось отправить ошибку админу.");
      setEmployeeIssueValue("");
      if (employeeIssueInputRef.current) {
        employeeIssueInputRef.current.focus();
      }
    } finally {
      setEmployeeIssueBusy(false);
    }
  };

  const handleScanSubmit = async (order, value) => {
    if (!employeeSelectedSupply || !order) return;
    if (!employeeSupplySession?.canWork) return;
    if (scanBusy) return;
    const barcode = value.trim();
    if (!barcode) return;
    setScanBusy(true);
    setScanError("");
    setEmployeeFlowWarning("");
    try {
      const data = await fetchJson(
        `${API_BASE}/employee/supplies/${encodeURIComponent(employeeSelectedSupply.id)}/orders/${order.id}/scan`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ barcode }),
        }
      );
      suppressEmployeeLiveRefresh();
      setEmployeeFlowWarning(data?.warning || "");
      setEmployeeSelectedOrder((prev) =>
        prev ? { ...prev, scanPassed: true, scanPassedAt: new Date().toISOString(), scanBarcode: barcode } : prev
      );
      setEmployeeOrders((list) =>
        list.map((item) =>
          item.id === order.id
            ? { ...item, scanPassed: true, scanPassedAt: new Date().toISOString(), scanBarcode: barcode }
            : item
        )
      );
      setScanValue("");
    } catch (err) {
      setScanError(err?.message || "Отсканируйте повторно");
      setScanValue("");
      if (scanInputRef.current) {
        scanInputRef.current.focus();
      }
    } finally {
      setScanBusy(false);
    }
  };

  const handleLabelScanSubmit = async (order, value) => {
    if (!employeeSelectedSupply || !order) return;
    if (!employeeSupplySession?.canWork) return;
    if (labelScanBusy) return;
    const barcode = value.trim();
    if (!barcode) return;
    setLabelScanBusy(true);
    setLabelScanError("");
    try {
      const data = await fetchJson(
        `${API_BASE}/employee/supplies/${encodeURIComponent(employeeSelectedSupply.id)}/orders/${order.id}/label-scan`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ barcode }),
        }
      );
      suppressEmployeeLiveRefresh();
      const nowIso = new Date().toISOString();
      setEmployeeSelectedOrder((prev) =>
        prev
          ? {
              ...prev,
              labelScanPassed: true,
              labelScanPassedAt: nowIso,
              labelScanBarcode: barcode,
            }
          : prev
      );
      setEmployeeOrders((list) =>
        list.map((item) =>
          item.id === order.id
            ? {
                ...item,
                labelScanPassed: true,
                labelScanPassedAt: nowIso,
                labelScanBarcode: barcode,
              }
            : item
        )
      );
      setLabelScanValue("");
      const currentItem = employeeSelectedItemRef.current;
      const sessionData = await loadEmployeeSupplySession(employeeSelectedSupply.id, { silent: true });
      await loadEmployeeSupplies({ silent: true });
      if (data?.sessionFinished || !sessionData?.canWork) {
        setEmployeeFlowNotice("Сборка завершена. Поставка закрыта автоматически.");
        setEmployeeSelectedOrder(null);
        setEmployeeSelectedItem(null);
      } else {
        const nextOrders = currentItem
          ? await loadEmployeeOrders(employeeSelectedSupply.id, currentItem, { silent: true })
          : [];
        await loadEmployeeItems(employeeSelectedSupply.id, { silent: true });
        if (nextOrders.length > 0) {
          setEmployeeSelectedOrder(nextOrders[0]);
          setEmployeeFlowNotice("Заказ собран. Открыт следующий заказ.");
        } else {
          setEmployeeSelectedOrder(null);
          setEmployeeSelectedItem(null);
          setEmployeeFlowNotice("Заказ собран. Можно сканировать следующий товар.");
        }
      }
    } catch (err) {
      setLabelScanError(err?.message || "Отсканируйте повторно");
      setLabelScanValue("");
      if (labelScanInputRef.current) {
        labelScanInputRef.current.focus();
      }
    } finally {
      setLabelScanBusy(false);
    }
  };

  useLayoutEffect(() => {
    if (!employeePickScrollRestoreRef.current) return;
    applyEmployeePickScrollSnapshot(employeePickScrollRestoreRef.current);
  }, [employeePickItems]);

  useEffect(() => {
    employeePickFocusGuardRef.current = { canFocus: Boolean(canKeepEmployeePickScanFocus) };
  }, [canKeepEmployeePickScanFocus]);

  useEffect(() => {
    employeeSelectedItemRef.current = employeeSelectedItem;
    employeeSelectedOrderRef.current = employeeSelectedOrder;
  }, [employeeSelectedItem, employeeSelectedOrder]);

  useEffect(() => {
    liveStateRef.current = {
      isAdmin,
      isEmployee: isPackerEmployee,
      tab,
      createOpen,
      selectedSupply,
      supplyTab,
      employeeSelectedSupply,
      employeeSelectedItem,
      employeeSelectedOrder,
    };
  }, [
    isAdmin,
    isPackerEmployee,
    tab,
    createOpen,
    selectedSupply,
    supplyTab,
    employeeSelectedSupply,
    employeeSelectedItem,
    employeeSelectedOrder,
  ]);

  const scheduleLiveRefresh = () => {
    if (liveTimerRef.current) return;
    liveTimerRef.current = setTimeout(() => {
      liveTimerRef.current = null;
      const state = liveStateRef.current;
      if (!state) return;
      if (state.isAdmin) {
        const withNewOrders = state.tab === "new" || state.createOpen;
        const lockSupplySettings = Boolean(state.selectedSupply && state.supplyTab === "settings");
        if (!lockSupplySettings) {
          loadData({ withNewOrders, withSupplies: true, silent: true });
        }
        if (state.selectedSupply) {
          if (state.supplyTab === "settings") {
            loadSupplySettings(state.selectedSupply, { silent: true });
          } else {
            loadSupplyOrders(state.selectedSupply, { silent: true });
          }
        }
        loadScanIssues({ silent: true });
      }
      if (state.isEmployee) {
        if (!state.employeeSelectedSupply) {
          loadEmployeeSupplies({ silent: true });
          return;
        }
        if (Date.now() < employeeLiveRefreshBlockedUntilRef.current) {
          return;
        }
        if (state.employeeSelectedOrder) return;
        loadEmployeeSupplySession(state.employeeSelectedSupply.id, { silent: true }).then((sessionData) => {
          const currentStage = sessionData?.workflow?.currentStage || "";
          if (currentStage === "picking") {
            loadEmployeePickItems(state.employeeSelectedSupply.id, { silent: true });
            return;
          }
          if (!sessionData?.canWork) return;
          if (state.employeeSelectedItem) {
            loadEmployeeOrders(
              state.employeeSelectedSupply.id,
              state.employeeSelectedItem,
              { silent: true }
            );
            return;
          }
          loadEmployeeItems(state.employeeSelectedSupply.id, { silent: true });
        });
      }
    }, 200);
  };

  useEffect(() => {
    if (!currentUser) return;
    const source = new EventSource(`${API_BASE}/events`);
    const handleEvent = () => scheduleLiveRefresh();
    const handleIssueUpdate = () => {
      if (isAdmin) {
        loadScanIssues({ silent: true });
      }
    };
    const handleIssueFixed = (event) => {
      let payload = {};
      try {
        payload = event?.data ? JSON.parse(event.data) : {};
      } catch {
        payload = {};
      }
      handleIssueUpdate();
      if (!isPackerEmployee) return;
      const issueStage = payload?.issueStage || "";
      const fixedSupplyId = payload?.supplyId || "";
      const fixedOrderId = Number(payload?.orderId);
      const fixedPickItemId = Number(payload?.pickItemId);
      if (issueStage === "pick_scan") {
        if (!fixedSupplyId || !Number.isFinite(fixedPickItemId)) return;
        if (employeeSelectedSupply?.id !== fixedSupplyId) return;
        setEmployeePickItems((prev) =>
          sortEmployeePickItems(
            prev.map((item) =>
              Number(item.id) === fixedPickItemId
                ? { ...item, bypassWithoutScanAllowed: true }
                : item
            )
          )
        );
        setEmployeePickIssueError("");
        setEmployeePickIssueOpen(false);
        setEmployeePickIssueValue("");
        setEmployeePickIssueItemId("");
        setEmployeeFlowNotice("Админ разрешил собрать один товар без штрихкода. Используйте кнопку «Собрать без шк».");
        return;
      }
      if (!fixedSupplyId || !Number.isFinite(fixedOrderId)) return;
      if (employeeSelectedSupply?.id !== fixedSupplyId) return;
      setEmployeeSelectedOrder((prev) => {
        if (!prev || Number(prev.id) !== fixedOrderId) return prev;
        return {
          ...prev,
          scanPassed: true,
          scanPassedAt: payload?.scanPassedAt || new Date().toISOString(),
          scanBarcode: payload?.scanBarcode || prev.scanBarcode || prev.barcode || null,
        };
      });
      setEmployeeOrders((list) =>
        list.map((item) =>
          Number(item.id) === fixedOrderId
            ? {
                ...item,
                scanPassed: true,
                scanPassedAt: payload?.scanPassedAt || new Date().toISOString(),
                scanBarcode: payload?.scanBarcode || item.scanBarcode || item.barcode || null,
              }
            : item
        )
      );
      setScanError("");
      setEmployeeFlowWarning("");
      setEmployeeIssueError("");
      setEmployeeIssueOpen(false);
      setEmployeeIssueValue("");
      setEmployeeFlowNotice("Админ подтвердил безошибочную сборку. Можно продолжать.");
    };
    source.addEventListener("supply_update", handleEvent);
    source.addEventListener("labels_progress", handleEvent);
    source.addEventListener("order_collected", handleEvent);
    source.addEventListener("scan_issue_update", handleIssueUpdate);
    source.addEventListener("scan_issue_fixed", handleIssueFixed);
    source.onmessage = handleEvent;
    source.onerror = () => {};
    scheduleLiveRefresh();
    return () => {
      source.close();
    };
  }, [currentUser, storeId, isAdmin, isPackerEmployee, employeeSelectedSupply?.id]);

  useEffect(() => {
    const handleFocus = () => scheduleLiveRefresh();
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        scheduleLiveRefresh();
      }
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [storeId]);

  useEffect(() => {
    return () => {
      if (liveTimerRef.current) {
        clearTimeout(liveTimerRef.current);
        liveTimerRef.current = null;
      }
      if (fbsStockPollRef.current) {
        clearInterval(fbsStockPollRef.current);
        fbsStockPollRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    loadData({ withNewOrders: false, withSupplies: true });
    loadScanIssues();
    const timer = setInterval(() => {
      if (selectedSupply && supplyTab === "settings") return;
      loadData({ withNewOrders: false, withSupplies: true, silent: true });
    }, REFRESH_SUPPLIES_MS);
    const issuesTimer = setInterval(() => {
      loadScanIssues({ silent: true });
    }, REFRESH_ISSUES_MS);
    return () => {
      clearInterval(timer);
      clearInterval(issuesTimer);
    };
  }, [isAdmin, storeId, selectedSupply, supplyTab]);

  useEffect(() => {
    if (!isAdmin || !storeId) return;
    setSelectedSupply(null);
    setCreateOpen(false);
    setNewOrders([]);
    setSupplies([]);
    setFbsStockItems([]);
    setFbsStockError("");
    setFbsStockTotals({ all: 0, ok: 0, shortage: 0, errors: 0 });
    setFbsStockUpdatedAt(null);
    setFbsStockProgress({
      stage: "idle",
      message: "",
      done: 0,
      total: 0,
      percent: 0,
      current: null,
      running: false,
    });
    setFbsStockRefreshing(false);
    setSupplyOrders([]);
    setSupplySettings(null);
    setSupplyAccessUsers([]);
    setSupplyEmployees([]);
    setSupplyProgress([]);
    setSupplyTotals({ total: 0, collected: 0, remaining: 0 });
    setLastUpdated(null);
    const withNewOrders = tab === "new" || createOpen;
    loadData({ withNewOrders, withSupplies: true });
  }, [isAdmin, storeId]);

  useEffect(() => {
    if (!isAdmin && !isSuper) return;
    loadStockProblems({ silent: true });
  }, [isAdmin, isSuper]);

  useEffect(() => {
    if (!isAdmin) return;
    if (!(tab === "new" || createOpen)) return;
    loadData({ withNewOrders: true, withSupplies: false });
    const timer = setInterval(() => {
      loadData({ withNewOrders: true, withSupplies: false, silent: true });
    }, REFRESH_NEW_ORDERS_MS);
    return () => clearInterval(timer);
  }, [isAdmin, tab, createOpen, storeId]);

  useEffect(() => {
    if (!isAdmin) return;
    if (tab !== "fbs_stock") return;
    loadFbsStockCheck();
  }, [isAdmin, tab, storeId]);

  useEffect(() => {
    if (!isAdmin && !isSuper) return;
    if (tab !== "stock_problems") return;
    loadStockProblems();
  }, [isAdmin, isSuper, tab]);

  useEffect(() => {
    if ((!isAdmin && !isSuper) || tab !== "stock_problems") return undefined;
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
  }, [isAdmin, isSuper, tab]);

  useEffect(() => {
    if (!isAdmin || tab !== "fbs_stock" || !fbsStockRefreshing) {
      if (fbsStockPollRef.current) {
        clearInterval(fbsStockPollRef.current);
        fbsStockPollRef.current = null;
      }
      return;
    }
    if (fbsStockPollRef.current) {
      clearInterval(fbsStockPollRef.current);
      fbsStockPollRef.current = null;
    }
    fbsStockPollRef.current = setInterval(() => {
      loadFbsStockCheck({ progressOnly: true, silent: true });
    }, 900);
    return () => {
      if (fbsStockPollRef.current) {
        clearInterval(fbsStockPollRef.current);
        fbsStockPollRef.current = null;
      }
    };
  }, [isAdmin, tab, fbsStockRefreshing, storeId]);

  useEffect(() => {
    if (!isAdmin || !selectedSupply) return;
    loadSupplyOrders(selectedSupply);
  }, [selectedSupply?.id, isAdmin]);

  useEffect(() => {
    if (!isAdmin || !selectedSupply || supplyTab !== "settings") return;
    loadSupplySettings(selectedSupply);
  }, [isAdmin, selectedSupply?.id, supplyTab]);

  useEffect(() => {
    if (!isAdmin || !selectedSupply) return;
    const timer = setInterval(() => {
      if (supplyTab === "settings") {
        loadSupplySettings(selectedSupply, { silent: true });
      } else {
        loadSupplyOrders(selectedSupply, { silent: true });
      }
    }, REFRESH_FAST_MS);
    return () => clearInterval(timer);
  }, [isAdmin, selectedSupply?.id, supplyTab, storeId]);

  useEffect(() => {
    if (isAdmin) return;
    setScanIssues([]);
    setScanIssuesError("");
    setScanIssueActionBusyId(null);
    setFbsStockItems([]);
    setFbsStockError("");
    setFbsStockTotals({ all: 0, ok: 0, shortage: 0, errors: 0 });
    setFbsStockUpdatedAt(null);
    setFbsStockProgress({
      stage: "idle",
      message: "",
      done: 0,
      total: 0,
      percent: 0,
      current: null,
      running: false,
    });
    setFbsStockRefreshing(false);
  }, [isAdmin]);

  useEffect(() => {
    if (!newItemsOpen) {
      setNewItemsTab("current");
      setNewItemsAllError("");
    }
  }, [newItemsOpen]);

  useEffect(() => {
    if (!newItemsOpen || newItemsTab !== "all") return;
    if (storeOptions.length === 0) return;
    loadNewOrdersAllStores();
  }, [newItemsOpen, newItemsTab, storeOptions]);

  useEffect(() => {
    if (tab !== "new") {
      setNewItemsOpen(false);
    }
  }, [tab]);

  useEffect(() => {
    if (selectedSupply) {
      const routeSupplyTab = pendingAdminSupplyTabRef.current;
      if (routeSupplyTab) {
        setSupplyTab(routeSupplyTab);
        pendingAdminSupplyTabRef.current = "";
      } else {
        setSupplyTab("orders");
      }
      setSupplyEmployeeQuery("");
    }
  }, [selectedSupply?.id]);

  useEffect(() => {
    if (!selectedSupply) {
      setSupplySettings(null);
      setSupplyAccessUsers([]);
      setSupplyEmployees([]);
      setSupplyProgress([]);
      setSupplyTotals({ total: 0, collected: 0, remaining: 0 });
      setSupplySettingsError("");
      setSupplySettingsNotice("");
      return;
    }
    setSupplySettings(null);
    setSupplyAccessMode(selectedSupply.accessMode || "hidden");
    setSupplyAccessUsers([]);
    setSupplyEmployees([]);
    setSupplyProgress([]);
    setSupplyTotals({
      total: Number(selectedSupply.orderCount || 0),
      collected: Number(selectedSupply.collectedCount || 0),
      remaining: Number(selectedSupply.remainingCount || 0),
    });
    setSupplySettingsError("");
    setSupplySettingsNotice("");
  }, [selectedSupply?.id]);

  useEffect(() => {
    const pages = Math.max(1, Math.ceil(newOrders.length / PAGE_SIZE));
    setPage((prev) => Math.min(prev, pages));
  }, [newOrders.length]);

  useEffect(() => {
    if (!currentUser) return;
    if (isSuper) {
      loadUsers();
      loadUserDirectory();
    }
  }, [currentUser, isAdmin, isSuper, tab, userTab]);

  useEffect(() => {
    if (!currentUser || !isAdmin) return;
    loadUsers();
    loadUserDirectory();
    const timer = setInterval(() => {
      loadUsers();
      loadUserDirectory();
    }, 15000);
    return () => clearInterval(timer);
  }, [currentUser, isAdmin]);

  useEffect(() => {
    if (!employeeStatsUser) return;
    if (employeeStatsRangeKey === "custom") return;
    loadEmployeeStats(employeeStatsUser, { rangeKey: employeeStatsRangeKey });
  }, [employeeStatsUser, employeeStatsRangeKey]);

  useEffect(() => {
    if (isAdmin) return;
    setNewOrders([]);
    setSupplies([]);
    setSelectedSupply(null);
  }, [isAdmin]);

  useEffect(() => {
    if (!isPackerEmployee || employeeSelectedSupply) return;
    loadEmployeeSupplies();
    const timer = setInterval(() => {
      loadEmployeeSupplies({ silent: true });
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [isPackerEmployee, employeeSelectedSupply]);

  useEffect(() => {
    if (!employeeSelectedSupply) return;
    if (employeeLookupTimerRef.current) {
      clearTimeout(employeeLookupTimerRef.current);
      employeeLookupTimerRef.current = null;
    }
    if (employeeIssueTimerRef.current) {
      clearTimeout(employeeIssueTimerRef.current);
      employeeIssueTimerRef.current = null;
    }
    if (employeePickScanTimerRef.current) {
      clearTimeout(employeePickScanTimerRef.current);
      employeePickScanTimerRef.current = null;
    }
    if (employeePickIssueTimerRef.current) {
      clearTimeout(employeePickIssueTimerRef.current);
      employeePickIssueTimerRef.current = null;
    }
    setEmployeeLookupValue("");
    setEmployeeLookupError("");
    setEmployeeLookupBusy(false);
    setEmployeeSupplySession(null);
    setEmployeeSupplySessionError("");
    setEmployeeStartError("");
    setEmployeeFlowNotice("");
    setEmployeeFlowWarning("");
    setEmployeeIssueOpen(false);
    setEmployeeIssueValue("");
    setEmployeeIssueError("");
    setEmployeeIssueBusy(false);
    setEmployeePickIssueOpen(false);
    setEmployeePickIssueValue("");
    setEmployeePickIssueItemId("");
    setEmployeePickIssueError("");
    setEmployeePickIssueBusy(false);
    pendingEmployeeOrderRef.current = null;
    setEmployeeSelectedItem(null);
    setEmployeeSelectedOrder(null);
    setEmployeeItems([]);
    setEmployeePickItems([]);
    setEmployeePickItemsError("");
    setEmployeePickScanValue("");
    setEmployeePickScanError("");
    setEmployeePickScanBusy(false);
    setEmployeePickFinishError("");
    setEmployeePickFinishBusy(false);
    setEmployeePickManualBusyId(null);
    setEmployeeOrders([]);
    loadEmployeeSupplySession(employeeSelectedSupply.id);
  }, [employeeSelectedSupply?.id]);

  useEffect(() => {
    if (employeeSelectedSupply) return;
    if (employeePickScanTimerRef.current) {
      clearTimeout(employeePickScanTimerRef.current);
      employeePickScanTimerRef.current = null;
    }
    if (employeePickIssueTimerRef.current) {
      clearTimeout(employeePickIssueTimerRef.current);
      employeePickIssueTimerRef.current = null;
    }
    setEmployeeSupplySession(null);
    setEmployeeSupplySessionError("");
    setEmployeeStartError("");
    setEmployeeFlowNotice("");
    setEmployeeFlowWarning("");
    setEmployeeIssueOpen(false);
    setEmployeeIssueValue("");
    setEmployeeIssueError("");
    setEmployeeIssueBusy(false);
    setEmployeePickIssueOpen(false);
    setEmployeePickIssueValue("");
    setEmployeePickIssueItemId("");
    setEmployeePickIssueError("");
    setEmployeePickIssueBusy(false);
    setEmployeeItems([]);
    setEmployeePickItems([]);
    setEmployeePickItemsError("");
    setEmployeePickScanValue("");
    setEmployeePickScanError("");
    setEmployeePickScanBusy(false);
    setEmployeePickFinishError("");
    setEmployeePickFinishBusy(false);
    setEmployeePickManualBusyId(null);
    setEmployeeOrders([]);
    setEmployeeSelectedItem(null);
    setEmployeeSelectedOrder(null);
    setEmployeeLookupValue("");
    setEmployeeLookupError("");
    setEmployeeLookupBusy(false);
    pendingEmployeeOrderRef.current = null;
  }, [employeeSelectedSupply]);

  useEffect(() => {
    const currentStage = employeeSupplySession?.workflow?.currentStage || "";
    if (currentStage !== "picking") {
      setEmployeePickItems([]);
    }
    if (!employeeSupplySession?.canWork) {
      setEmployeeItems([]);
      setEmployeeOrders([]);
      setEmployeeSelectedItem(null);
      setEmployeeSelectedOrder(null);
      if (currentStage !== "picking") return;
    }
    if (employeeSelectedSupply?.id && currentStage === "picking") {
      loadEmployeePickItems(employeeSelectedSupply.id, { silent: true });
    } else if (employeeSelectedSupply?.id && employeeSupplySession?.canWork) {
      loadEmployeeItems(employeeSelectedSupply.id, { silent: true });
    }
  }, [employeeSupplySession?.canWork, employeeSupplySession?.workflow?.currentStage, employeeSelectedSupply?.id]);

  useEffect(() => {
    if (employeeLookupTimerRef.current) {
      clearTimeout(employeeLookupTimerRef.current);
      employeeLookupTimerRef.current = null;
    }
    if (employeeIssueTimerRef.current) {
      clearTimeout(employeeIssueTimerRef.current);
      employeeIssueTimerRef.current = null;
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
    setScanValue("");
    setScanError("");
    setScanBusy(false);
    setEmployeePickScanValue("");
    setEmployeePickScanError("");
    setEmployeePickScanBusy(false);
    setEmployeeIssueOpen(false);
    setEmployeeIssueValue("");
    setEmployeeIssueError("");
    setEmployeeIssueBusy(false);
    setEmployeePickIssueOpen(false);
    setEmployeePickIssueValue("");
    setEmployeePickIssueItemId("");
    setEmployeePickIssueError("");
    setEmployeePickIssueBusy(false);
    setEmployeePickManualBusyId(null);
    setLabelScanValue("");
    setLabelScanError("");
    setLabelScanBusy(false);
    setLabelOpened(false);
    if (employeeSelectedOrder && !employeeSelectedOrder.scanPassed) {
      setTimeout(() => {
        if (scanInputRef.current) {
          scanInputRef.current.focus();
        }
      }, 50);
    }
  }, [employeeSelectedOrder]);

  useEffect(() => {
    if (!canKeepEmployeePickScanFocus) return;
    if (employeePickScanBusy) return;
    queueEmployeePickScanFocus();
  }, [canKeepEmployeePickScanFocus, employeePickScanBusy]);

  useEffect(() => {
    if (employeeSupplySession?.workflow?.currentStage !== "picking") return;
    if (employeeSelectedItem || employeeSelectedOrder || employeePickIssueOpen) return;
    const value = employeePickScanValue.trim();
    if (!value) return;
    if (employeePickScanTimerRef.current) clearTimeout(employeePickScanTimerRef.current);
    employeePickScanTimerRef.current = setTimeout(() => {
      employeePickScanTimerRef.current = null;
      handleEmployeePickScan(value);
    }, 200);
  }, [
    employeePickScanValue,
    employeeSupplySession?.workflow?.currentStage,
    employeeSelectedItem,
    employeeSelectedOrder,
    employeePickIssueOpen,
  ]);

  useEffect(() => {
    if (!employeeSelectedSupply || !employeeSupplySession?.canWork || employeeSelectedItem || employeeSelectedOrder) return;
    setTimeout(() => {
      if (employeeLookupInputRef.current) {
        employeeLookupInputRef.current.focus();
      }
    }, 50);
  }, [employeeSelectedSupply, employeeSupplySession, employeeSelectedItem, employeeSelectedOrder]);

  useEffect(() => {
    if (!employeeSelectedSupply || !employeeSupplySession?.canWork || employeeSelectedItem || employeeSelectedOrder) return;
    const value = employeeLookupValue.trim();
    if (!value) return;
    if (employeeLookupTimerRef.current) clearTimeout(employeeLookupTimerRef.current);
    employeeLookupTimerRef.current = setTimeout(() => {
      employeeLookupTimerRef.current = null;
      handleEmployeeLookupScan(value);
    }, 200);
  }, [employeeLookupValue, employeeSelectedSupply, employeeSupplySession, employeeSelectedItem, employeeSelectedOrder]);

  useEffect(() => {
    if (!employeeSelectedOrder || employeeSelectedOrder.scanPassed) return;
    const value = scanValue.trim();
    if (!value) return;
    if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    scanTimerRef.current = setTimeout(() => {
      scanTimerRef.current = null;
      handleScanSubmit(employeeSelectedOrder, value);
    }, 200);
  }, [scanValue, employeeSelectedOrder]);

  useEffect(() => {
    if (!employeeSelectedOrder || !employeeSelectedOrder.scanPassed) return;
    if (employeeSelectedOrder.labelScanPassed) return;
    if (!labelOpened) return;
    setTimeout(() => {
      if (labelScanInputRef.current) {
        labelScanInputRef.current.focus();
      }
    }, 50);
  }, [employeeSelectedOrder, labelOpened]);

  useEffect(() => {
    if (!employeeSelectedOrder || !employeeSelectedOrder.scanPassed) return;
    if (employeeSelectedOrder.labelScanPassed) return;
    if (!labelOpened) return;
    const value = labelScanValue.trim();
    if (!value) return;
    if (labelScanTimerRef.current) clearTimeout(labelScanTimerRef.current);
    labelScanTimerRef.current = setTimeout(() => {
      labelScanTimerRef.current = null;
      handleLabelScanSubmit(employeeSelectedOrder, value);
    }, 200);
  }, [labelScanValue, employeeSelectedOrder, labelOpened]);

  useEffect(() => {
    if (!employeeSelectedSupply || !employeeSupplySession?.canWork || !employeeSelectedItem) return;
    const hasPendingOrder =
      pendingEmployeeOrderRef.current?.supplyId === employeeSelectedSupply.id &&
      pendingEmployeeOrderRef.current?.orderId;
    if (!hasPendingOrder) {
      setEmployeeSelectedOrder(null);
    }
    loadEmployeeOrders(employeeSelectedSupply.id, employeeSelectedItem);
  }, [
    employeeSelectedItem?.article,
    employeeSelectedItem?.barcode,
    employeeSelectedItem?.nmId,
    employeeSelectedItem?.productName,
    employeeSelectedSupply?.id,
    employeeSupplySession?.canWork,
  ]);

  useEffect(() => {
    if (!employeeIssueOpen || !employeeSelectedOrder || employeeSelectedOrder.scanPassed) return;
    setTimeout(() => {
      if (employeeIssueInputRef.current) {
        employeeIssueInputRef.current.focus();
      }
    }, 50);
  }, [employeeIssueOpen, employeeSelectedOrder]);

  useEffect(() => {
    if (!employeeIssueOpen || !employeeSelectedOrder || employeeSelectedOrder.scanPassed) return;
    const value = employeeIssueValue.trim();
    if (!value) return;
    if (employeeIssueTimerRef.current) clearTimeout(employeeIssueTimerRef.current);
    employeeIssueTimerRef.current = setTimeout(() => {
      employeeIssueTimerRef.current = null;
      handleEmployeeIssueSubmit(employeeSelectedOrder, value);
    }, 200);
  }, [employeeIssueValue, employeeIssueOpen, employeeSelectedOrder]);

  useEffect(() => {
    if (employeeIssueOpen) return;
    if (employeeIssueTimerRef.current) {
      clearTimeout(employeeIssueTimerRef.current);
      employeeIssueTimerRef.current = null;
    }
  }, [employeeIssueOpen]);

  useEffect(() => {
    if (!employeePickIssueOpen || employeeSupplySession?.workflow?.currentStage !== "picking") return;
    setTimeout(() => {
      if (employeePickIssueInputRef.current) {
        employeePickIssueInputRef.current.focus();
      }
    }, 50);
  }, [employeePickIssueOpen, employeeSupplySession?.workflow?.currentStage]);

  useEffect(() => {
    if (!employeePickIssueOpen || employeeSupplySession?.workflow?.currentStage !== "picking") return;
    const value = employeePickIssueValue.trim();
    if (!value) return;
    if (!employeePickIssueItemId) return;
    if (employeePickIssueTimerRef.current) clearTimeout(employeePickIssueTimerRef.current);
    employeePickIssueTimerRef.current = setTimeout(() => {
      employeePickIssueTimerRef.current = null;
      handleEmployeePickIssueSubmit(value);
    }, 200);
  }, [employeePickIssueValue, employeePickIssueOpen, employeePickIssueItemId, employeeSupplySession?.workflow?.currentStage]);

  useEffect(() => {
    if (employeePickIssueOpen) return;
    if (employeePickIssueTimerRef.current) {
      clearTimeout(employeePickIssueTimerRef.current);
      employeePickIssueTimerRef.current = null;
    }
  }, [employeePickIssueOpen]);

  useEffect(() => {
    if (!employeePickIssueOpen) return;
    const firstPending = employeePickItems.find((item) => Number(item?.remainingQty || 0) > 0);
    if (!firstPending) return;
    const currentId = Number(employeePickIssueItemId);
    const exists = employeePickItems.some((item) => Number(item.id) === currentId && Number(item?.remainingQty || 0) > 0);
    if (exists) return;
    setEmployeePickIssueItemId(String(firstPending.id));
  }, [employeePickIssueOpen, employeePickIssueItemId, employeePickItems]);

  useEffect(() => {
    return () => {
      if (employeeLookupTimerRef.current) {
        clearTimeout(employeeLookupTimerRef.current);
        employeeLookupTimerRef.current = null;
      }
      if (employeeIssueTimerRef.current) {
        clearTimeout(employeeIssueTimerRef.current);
        employeeIssueTimerRef.current = null;
      }
      if (employeePickIssueTimerRef.current) {
        clearTimeout(employeePickIssueTimerRef.current);
        employeePickIssueTimerRef.current = null;
      }
      if (employeePickScanTimerRef.current) {
        clearTimeout(employeePickScanTimerRef.current);
        employeePickScanTimerRef.current = null;
      }
    };
  }, []);

  
  const safeCreateCount = Math.max(1, Number(createCount) || 1);
  const selection = useMemo(
    () => pickOrders(newOrders, createSort, safeCreateCount),
    [newOrders, createSort, safeCreateCount]
  );

  const newItems = useMemo(() => {
    const map = new Map();
    for (const order of newOrders) {
      const name = order.productName || order.article || "—";
      const barcode = order.barcode || "—";
      const article = order.article || "—";
      const nmId = order.nmId || "—";
      const key = `${name}||${barcode}||${article}||${nmId}`;
      const rawQty = Number(order.quantity ?? 1);
      const qty = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : 1;
      const entry = map.get(key) || { name, barcode, article, nmId, count: 0 };
      entry.count += qty;
      map.set(key, entry);
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [newOrders]);

  const allStores = useMemo(() => storeOptions.slice(0, 2), [storeOptions]);

  const allStoreItems = useMemo(() => {
    if (!newOrdersByStore.length) return [];
    const map = new Map();
    for (const entry of newOrdersByStore) {
      const storeId = entry?.store?.id;
      if (!storeId) continue;
      const orders = Array.isArray(entry?.orders) ? entry.orders : [];
      for (const order of orders) {
        const name = order.productName || order.article || "—";
        const barcode = order.barcode || "—";
        const article = order.article || "—";
        const nmId = order.nmId || "—";
        const key = `${name}||${barcode}||${article}||${nmId}`;
        const rawQty = Number(order.quantity ?? 1);
        const qty = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : 1;
        const item = map.get(key) || { name, barcode, article, nmId, total: 0, byStore: {} };
        item.total += qty;
        item.byStore[storeId] = (item.byStore[storeId] || 0) + qty;
        map.set(key, item);
      }
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [newOrdersByStore]);

  const supplyItems = useMemo(() => {
    return aggregateSupplyItems(supplyOrders);
  }, [supplyOrders]);

  const articleMap = useMemo(() => {
    const map = new Map();
    for (const order of newOrders) {
      const article = order.article;
      if (!article) continue;
      const entry =
        map.get(article) || {
          article,
          name: order.productName || "",
          barcode: order.barcode || "",
          nmId: order.nmId || "",
          orders: [],
        };
      entry.orders.push(order);
      if (!entry.name && order.productName) entry.name = order.productName;
      if (!entry.barcode && order.barcode) entry.barcode = order.barcode;
      if (!entry.nmId && order.nmId) entry.nmId = order.nmId;
      map.set(article, entry);
    }
    for (const entry of map.values()) {
      entry.orders.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    }
    return map;
  }, [newOrders]);

  const articleOptions = useMemo(
    () => Array.from(articleMap.values()).sort((a, b) => b.orders.length - a.orders.length),
    [articleMap]
  );

  const articleSelection = useMemo(
    () => buildArticleSelection(articleRows, articleMap),
    [articleRows, articleMap]
  );

  const articleRequested = useMemo(
    () => articleRows.reduce((sum, row) => sum + (Number(row.count) || 0), 0),
    [articleRows]
  );
  useEffect(() => {
    if (articleOptions.length === 0) return;
    setArticleRows((rows) =>
      rows.map((row) => {
        if (row.article && articleMap.has(row.article)) return row;
        const first = articleOptions[0];
        const max = first?.orders?.length || 0;
        return {
          ...row,
          article: first.article,
          count: Math.min(Math.max(1, row.count || 1), max || 1),
        };
      })
    );
  }, [articleOptions, articleMap]);

  useEffect(() => {
    setArticleRows((rows) => {
      let changed = false;
      const next = rows.map((row) => {
        const available =
          row.article && articleSelection.availableByArticle.get(row.article)
            ? articleSelection.availableByArticle.get(row.article)
            : 0;
        const target =
          available === 0 ? 0 : Math.min(Math.max(1, Number(row.count) || 1), available);
        if (row.count !== target) {
          changed = true;
          return { ...row, count: target };
        }
        return row;
      });
      return changed ? next : rows;
    });
  }, [articleSelection.availableByArticle]);

  const totalPages = Math.max(1, Math.ceil(newOrders.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageEnd = pageStart + PAGE_SIZE;
  const pagedOrders = newOrders.slice(pageStart, pageEnd);
  const pageFrom = newOrders.length ? pageStart + 1 : 0;
  const pageTo = Math.min(pageEnd, newOrders.length);
  const canCreate =
    createMode === "articles"
      ? articleSelection.selected.length > 0
      : selection.selected.length > 0;
  const requestedCount = createMode === "articles" ? articleRequested : safeCreateCount;
  const selectedCount =
    createMode === "articles" ? articleSelection.selected.length : selection.selected.length;
  const hasLimitWarning = selectedCount < requestedCount;

  const labelsTotal = Number(supplySettings?.labelsTotal || 0);
  const labelsLoaded = Number(supplySettings?.labelsLoaded || 0);
  const labelsProgress = labelsTotal > 0 ? Math.min(100, Math.round((labelsLoaded / labelsTotal) * 100)) : 0;
  const hasAssignments = supplyProgress.some(
    (entry) => Number(entry.total || 0) > 0 || Number(entry.pickingTotal || 0) > 0
  );
  const supplyPickingProgress = aggregatePickingProgress(supplyProgress);
  const employeeWorkflowMode = supplySettings?.employeeWorkflowMode || "legacy";
  const employeeWorkflowIsPicking = employeeWorkflowMode === "picking";
  const stockMethodEnabled = supplySettings?.stockMethodEnabled === true;

  const handleExportNewItems = async () => {
    if (!newItems.length) return;
    try {
      const XLSX = await import("xlsx");
      const rows = newItems.map((item) => ({
        "Название": item.name || "",
        "Баркод": item.barcode || "",
        "Артикул продавца": item.article || "",
        "Артикул WB": item.nmId || "",
        "Кол-во": item.count || 0,
      }));
      const header = ["Название", "Баркод", "Артикул продавца", "Артикул WB", "Кол-во"];
      const sheet = XLSX.utils.json_to_sheet(rows, { header });
      sheet["!cols"] = [
        { wch: 40 },
        { wch: 20 },
        { wch: 20 },
        { wch: 18 },
        { wch: 10 },
      ];
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, "Новые товары");
      const data = XLSX.write(book, { bookType: "xlsx", type: "array" });
      const blob = new Blob([data], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "new_orders_items.xlsx";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Excel export failed", err);
    }
  };

  const handleEmployeePickIssueSubmit = async (value) => {
    if (!employeeSelectedSupply) return;
    if (employeeSupplySession?.workflow?.currentStage !== "picking") return;
    if (employeePickIssueBusy) return;
    const barcode = value.trim();
    const pickItemId = Number(employeePickIssueItemId);
    if (!barcode) return;
    if (!Number.isFinite(pickItemId) || pickItemId < 1) {
      setEmployeePickIssueError("Выберите товар из списка.");
      return;
    }
    setEmployeePickIssueBusy(true);
    setEmployeePickIssueError("");
    setEmployeeFlowWarning("");
    try {
      await fetchJson(
        `${API_BASE}/employee/supplies/${encodeURIComponent(employeeSelectedSupply.id)}/pick-issue`,
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
      setEmployeePickIssueError(err?.message || "Не удалось отправить ошибку админу.");
      setEmployeePickIssueValue("");
      if (employeePickIssueInputRef.current) {
        employeePickIssueInputRef.current.focus();
      }
    } finally {
      setEmployeePickIssueBusy(false);
    }
  };

  const handleEmployeePickCollectWithoutScan = async (itemId) => {
    if (!employeeSelectedSupply || !itemId || employeePickManualBusyId) return;
    setEmployeePickManualBusyId(itemId);
    setEmployeePickScanError("");
    setEmployeeFlowWarning("");
    try {
      const data = await fetchJson(
        `${API_BASE}/employee/supplies/${encodeURIComponent(employeeSelectedSupply.id)}/pick-items/${itemId}/collect-without-scan`,
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
        setEmployeeSupplySession((prev) => (prev ? { ...prev, session: data.session } : prev));
        setEmployeeSelectedSupply((prev) =>
          prev && prev.id === employeeSelectedSupply.id ? { ...prev, session: data.session } : prev
        );
      }
      setEmployeeFlowNotice(
        data?.completed
          ? "Все товары собраны. Нажмите «Завершить сборку товара»."
          : "Товар собран без штрихкода по разрешению администратора."
      );
    } catch (err) {
      if (handleAuthError(err)) return;
      setEmployeePickScanError(err?.message || "Не удалось собрать товар без штрихкода.");
    } finally {
      setEmployeePickManualBusyId(null);
    }
  };

  const loadNewOrdersAllStores = async () => {
    if (newItemsAllLoading) return;
    setNewItemsAllLoading(true);
    setNewItemsAllError("");
    try {
      const stores = storeOptions.slice(0, 2);
      if (!stores.length) {
        setNewOrdersByStore([]);
        setNewItemsAllUpdatedAt(null);
        return;
      }
      const results = await Promise.all(
        stores.map(async (store) => {
          const data = await fetchJson(`${API_BASE}/new-orders`, {
            headers: { "X-Store-Id": store.id },
          });
          return {
            store,
            orders: Array.isArray(data?.orders) ? data.orders : [],
          };
        })
      );
      setNewOrdersByStore(results);
      setNewItemsAllUpdatedAt(new Date());
    } catch (err) {
      if (handleAuthError(err)) return;
      setNewItemsAllError(err?.message || "Не удалось загрузить заказы по магазинам.");
    } finally {
      setNewItemsAllLoading(false);
    }
  };

  const handleExportAllItems = async () => {
    if (!allStoreItems.length) return;
    try {
      const XLSX = await import("xlsx");
      const store1 = allStores[0];
      const store2 = allStores[1];
      const label1 = store1?.name || "Магазин 1";
      const label2 = store2?.name || "Магазин 2";
      const rows = allStoreItems.map((item) => ({
        "Название": item.name || "",
        "Баркод": item.barcode || "",
        "Артикул продавца": item.article || "",
        "Артикул WB": item.nmId || "",
        "Кол-во всего": item.total || 0,
        [label1]: store1 ? item.byStore?.[store1.id] || 0 : 0,
        [label2]: store2 ? item.byStore?.[store2.id] || 0 : 0,
      }));
      const header = ["Название", "Баркод", "Артикул продавца", "Артикул WB", "Кол-во всего", label1, label2];
      const sheet = XLSX.utils.json_to_sheet(rows, { header });
      sheet["!cols"] = [
        { wch: 40 },
        { wch: 20 },
        { wch: 20 },
        { wch: 18 },
        { wch: 12 },
        { wch: 14 },
        { wch: 14 },
      ];
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, "Все магазины");
      const data = XLSX.write(book, { bookType: "xlsx", type: "array" });
      const blob = new Blob([data], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "new_orders_items_all_stores.xlsx";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Excel export failed", err);
    }
  };

  const handleExportItems = async () => {
    if (!supplyItems.length || !selectedSupply) return;
    try {
      const XLSX = await import("xlsx");
      const rows = supplyItems.map((item) => ({
        "Название": item.name || "",
        "Баркод": item.barcode || "",
        "Артикул продавца": item.article || "",
        "Артикул WB": item.nmId || "",
        "Кол-во": item.count || 0,
      }));
      const header = ["Название", "Баркод", "Артикул продавца", "Артикул WB", "Кол-во"];
      const sheet = XLSX.utils.json_to_sheet(rows, { header });
      sheet["!cols"] = [
        { wch: 40 },
        { wch: 20 },
        { wch: 20 },
        { wch: 18 },
        { wch: 10 },
      ];
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, "Товары");
      const data = XLSX.write(book, { bookType: "xlsx", type: "array" });
      const blob = new Blob([data], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `supply_${selectedSupply.id}_items.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Excel export failed", err);
    }
  };

  const handleExportEmployeeSupplyItems = async (entry) => {
    if (!selectedSupply || !entry?.userId) return;
    setSupplySettingsNotice("");
    setSupplySettingsError("");
    let orders = supplyOrders;
    if (!orders.length) {
      orders = await loadSupplyOrders(selectedSupply, { silent: true });
    }
    const assignedOrders = (Array.isArray(orders) ? orders : []).filter(
      (order) => Number(order?.assignedUserId || 0) === Number(entry.userId)
    );
    const items = aggregateSupplyItems(assignedOrders);
    if (!items.length) {
      setSupplySettingsNotice(`Для сотрудника ${entry.surname || ""} ${entry.name || ""} нет назначенных товаров.`);
      return;
    }
    const totalCount = items.reduce((sum, item) => sum + Number(item.count || 0), 0);
    try {
      const XLSX = await import("xlsx");
      const rows = items.map((item) => ({
        "Название": item.name || "",
        "Баркод": item.barcode || "",
        "Артикул продавца": item.article || "",
        "Артикул WB": item.nmId || "",
        "Кол-во": item.count || 0,
      }));
      const header = ["Название", "Баркод", "Артикул продавца", "Артикул WB", "Кол-во"];
      const sheet = XLSX.utils.json_to_sheet(rows, { header });
      sheet["!cols"] = [{ wch: 40 }, { wch: 20 }, { wch: 20 }, { wch: 18 }, { wch: 10 }];
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, "Товары");
      const data = XLSX.write(book, { bookType: "xlsx", type: "array" });
      const blob = new Blob([data], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const fileSurname = sanitizeFilePart(entry.surname || `employee_${entry.userId}`, `employee_${entry.userId}`);
      link.download = `${fileSurname}_${totalCount}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Excel export failed", err);
    }
  };

  const handleCreateSupply = async () => {
    setCreateError("");
    setCreateSuccess("");
    setCreateWarning("");
    if (!createName.trim()) {
      setCreateError("Введите название поставки.");
      return;
    }
    const selectedOrders =
      createMode === "articles" ? articleSelection.selected : selection.selected;
    if (!selectedOrders.length) {
      setCreateError("Нет доступных заказов для добавления.");
      return;
    }
    try {
      setCreateBusy(true);
      const payload = {
        name: createName.trim(),
        orders: selectedOrders.map((o) => o.id),
      };
      const data = await adminFetch(`${API_BASE}/supplies/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const addedCount = Number(data?.addedCount ?? 0);
      const failedCount = Number(data?.failedCount ?? 0);
      const failedReason = data?.failedReason ? String(data.failedReason) : "";
      const failedIds = Array.isArray(data?.failedIds) ? data.failedIds : [];
      if (failedCount > 0) {
        const reasonText = failedReason ? ` Причина: ${failedReason}` : "";
        const idsText = failedIds.length ? ` Примеры ID: ${failedIds.join(", ")}` : "";
        setCreateWarning(
          `Поставка создана: ${data.supplyId}. Добавлено ${addedCount}, не добавлено ${failedCount}.${reasonText}${idsText}`
        );
        if (addedCount > 0) {
          setCreateOpen(false);
          setCreateName("");
          await loadData();
        }
        return;
      }
      setCreateSuccess(`Поставка создана: ${data.supplyId}`);
      setCreateOpen(false);
      setCreateName("");
      await loadData();
    } catch (err) {
      setCreateError(err?.message || "Не удалось создать поставку. Проверьте доступы и заказы.");
    } finally {
      setCreateBusy(false);
    }
  };

  if (!authChecked) {
    return (
      <div className="app">
        <section className="card">
          <div className="empty">Проверяем доступ…</div>
        </section>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <LoginView
        loginSurname={loginSurname}
        setLoginSurname={setLoginSurname}
        loginPassword={loginPassword}
        setLoginPassword={setLoginPassword}
        loginError={loginError}
        loginBusy={loginBusy}
        handleLogin={handleLogin}
      />
    );
  }

  if (isSuper) {
    return (
      <SuperAdminView
        currentUser={currentUser}
        userTab={userTab}
        setUserTab={setUserTab}
        users={users}
        usersLoading={usersLoading}
        usersError={usersError}
        userDirectory={userDirectory}
        userDirectoryLoading={userDirectoryLoading}
        userDirectoryError={userDirectoryError}
        userActionError={userActionError}
        userActionBusy={userActionBusy}
        createExternalUserId={createExternalUserId}
        setCreateExternalUserId={setCreateExternalUserId}
        handleCreateUser={handleCreateUser}
        handleLogout={handleLogout}
        openEditUser={openEditUser}
        handleDeleteUser={handleDeleteUser}
        editUser={editUser}
        setEditUser={setEditUser}
        editRole={editRole}
        setEditRole={setEditRole}
        handleSaveUser={handleSaveUser}
        formatDate={formatDate}
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
        employeeSuppliesError={employeeSuppliesError}
        employeeSuppliesLoading={employeeSuppliesLoading}
        employeeSupplies={employeeSupplies}
        employeeSelectedSupply={employeeSelectedSupply}
        setEmployeeSelectedSupply={setEmployeeSelectedSupply}
        employeeSelectedOrder={employeeSelectedOrder}
        setEmployeeSelectedOrder={setEmployeeSelectedOrder}
        employeeSelectedItem={employeeSelectedItem}
        setEmployeeSelectedItem={setEmployeeSelectedItem}
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
        handleEmployeePickFinish={handleEmployeePickFinish}
        employeeOrders={employeeOrders}
        employeeOrdersLoading={employeeOrdersLoading}
        employeeOrdersError={employeeOrdersError}
        employeeItems={employeeItems}
        employeeItemsLoading={employeeItemsLoading}
        employeeItemsError={employeeItemsError}
        employeeLookupInputRef={employeeLookupInputRef}
        employeeLookupValue={employeeLookupValue}
        setEmployeeLookupValue={setEmployeeLookupValue}
        employeeLookupBusy={employeeLookupBusy}
        employeeLookupError={employeeLookupError}
        employeeSupplySession={employeeSupplySession}
        employeeSupplySessionLoading={employeeSupplySessionLoading}
        employeeSupplySessionError={employeeSupplySessionError}
        employeeStartBusy={employeeStartBusy}
        employeeStartError={employeeStartError}
        employeeFlowNotice={employeeFlowNotice}
        employeeFlowWarning={employeeFlowWarning}
        employeeIssueOpen={employeeIssueOpen}
        setEmployeeIssueOpen={setEmployeeIssueOpen}
        employeeIssueInputRef={employeeIssueInputRef}
        employeeIssueValue={employeeIssueValue}
        setEmployeeIssueValue={setEmployeeIssueValue}
        employeeIssueBusy={employeeIssueBusy}
        employeeIssueError={employeeIssueError}
        setEmployeeIssueError={setEmployeeIssueError}
        handleEmployeeIssueSubmit={handleEmployeeIssueSubmit}
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
        handleEmployeePickIssueSubmit={handleEmployeePickIssueSubmit}
        employeePickManualBusyId={employeePickManualBusyId}
        handleEmployeePickCollectWithoutScan={handleEmployeePickCollectWithoutScan}
        handleEmployeeStart={handleEmployeeStart}
        labelScanInputRef={labelScanInputRef}
        labelScanValue={labelScanValue}
        setLabelScanValue={setLabelScanValue}
        labelOpened={labelOpened}
        labelScanBusy={labelScanBusy}
        labelScanError={labelScanError}
        scanInputRef={scanInputRef}
        scanValue={scanValue}
        setScanValue={setScanValue}
        scanBusy={scanBusy}
        scanError={scanError}
        handleCollectOrder={handleCollectOrder}
        employeeCollectError={employeeCollectError}
        formatDate={formatDate}
        formatFbsCells={formatFbsCells}
        timeAgo={timeAgo}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="dot" />
          <div>
            <div className="title">WB Склад</div>
            <div className="subtitle">FBS • обновление каждые 30 секунд</div>
          </div>
        </div>
        <div className="topbar-right">
          <div className="status">
            {lastUpdated ? `Обновлено: ${lastUpdated.toLocaleTimeString("ru-RU")}` : "—"}
          </div>
          {storeOptions.length > 0 && (
            <label className="store-select">
              <span>Магазин</span>
              <select
                className="input store-input"
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
              >
                {storeOptions.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="user-chip">
            <div className="user-name">{currentUser.surname} {currentUser.name}</div>
            <div className="user-role">Админ</div>
          </div>
          <button className="ghost-button small" type="button" onClick={handleLogout}>
            Выйти
          </button>
        </div>
      </header>

      <div className="tabs">
        <button
          className={`tab ${tab === "new" ? "active" : ""}`}
          onClick={() => setTab("new")}
          type="button"
        >
          Новые
          <span className="badge">{newOrders.length}</span>
        </button>
        <button
          className={`tab ${tab === "assembling" ? "active" : ""}`}
          onClick={() => setTab("assembling")}
          type="button"
        >
          На сборке
          <span className="badge">{supplies.length}</span>
        </button>
        <button
          className={`tab ${tab === "fbs_stock" ? "active" : ""} ${fbsStockAlertCount > 0 ? "alerting" : ""}`}
          onClick={() => setTab("fbs_stock")}
          type="button"
        >
          Проверка остатков ФБС
          <span className={`badge ${fbsStockAlertCount > 0 ? "danger" : ""}`}>
            {fbsStockTotals.all || 0}
          </span>
        </button>
        <button
          className={`tab ${tab === "employees" ? "active" : ""}`}
          onClick={() => setTab("employees")}
          type="button"
        >
          Сотрудники
          <span className="badge">{users.length}</span>
        </button>
        <button
          className={`tab ${tab === "settings" ? "active" : ""} ${openScanIssueCount > 0 ? "alerting" : ""}`}
          onClick={() => setTab("settings")}
          type="button"
        >
          Настройки
          {openScanIssueCount > 0 ? <span className="badge danger">{openScanIssueCount}</span> : null}
        </button>
      </div>

      {error && <div className="alert">{error}</div>}
      {createSuccess && <div className="alert success">{createSuccess}</div>}
      {createWarning && <div className="alert warn">{createWarning}</div>}

      {tab === "assembling" && (
        <div className="actions">
          <div className="actions-left">
            <button
              className="primary-button"
              type="button"
              onClick={() => setCreateOpen(true)}
              disabled={newOrders.length === 0}
            >
              Создать новую поставку
            </button>
            <div className="hint">Добавляем заказы из вкладки «Новые» без ручного клика.</div>
          </div>
        </div>
      )}

      <section className="card">
        {tab === "settings" ? (
          <>
            <div className="section-header">
              <div className="section-title">Настройки</div>
              <div className="hint">Служебные разделы и ошибки сборки от сотрудников.</div>
            </div>
            <div className="subtabs">
              <button
                className={`subtab ${adminSettingsTab === "errors" ? "active" : ""} ${openScanIssueCount > 0 ? "danger" : ""}`}
                type="button"
                onClick={() => setAdminSettingsTab("errors")}
              >
                Ошибки
                {openScanIssueCount > 0 ? <span className="badge danger">{openScanIssueCount}</span> : null}
              </button>
            </div>
            {scanIssuesError && <div className="alert small">{scanIssuesError}</div>}
            {adminSettingsTab === "errors" && (
              <>
                <div className="actions">
                  <div className="actions-left">
                    <div className="hint">
                      {openScanIssueCount > 0
                        ? `Открытых ошибок: ${openScanIssueCount}`
                        : "Сейчас нет открытых ошибок от сотрудников"}
                    </div>
                  </div>
                </div>
                <div className="list issues">
                  <div className="list-header">
                    <div className="col">Сотрудник</div>
                    <div className="col">Поставка / заказ</div>
                    <div className="col">Товар</div>
                    <div className="col">Баркод / шк</div>
                    <div className="col">Создано</div>
                    <div className="col right">Действия</div>
                  </div>
                  <div className="list-body">
                    {scanIssuesLoading ? (
                      <div className="empty">Загрузка…</div>
                    ) : scanIssues.length === 0 ? (
                      <div className="empty">Нет активных ошибок</div>
                    ) : (
                      scanIssues.map((issue) => (
                        <div className="row" key={issue.id}>
                          <div className="col">
                            <div className="primary">{issue.employeeName || "—"}</div>
                            <div className="muted">ID {issue.employeeId}</div>
                          </div>
                          <div className="col">
                            <div className="primary">{issue.supplyName || `Поставка ${issue.supplyId}`}</div>
                            <div className="muted mono">
                              {issue.supplyId} · {issue.issueStageLabel}
                              {issue.orderId ? ` · заказ ${issue.orderId}` : ""}
                            </div>
                            {issue.errorMessage ? <div className="alert small">{issue.errorMessage}</div> : null}
                            {issue.contextNote ? <div className="muted">{issue.contextNote}</div> : null}
                          </div>
                          <div className="col">
                            <div className="primary">{issue.productName || "—"}</div>
                            <div className="muted mono">
                              {issue.article || "—"}
                              {issue.nmId ? ` · WB ${issue.nmId}` : ""}
                            </div>
                          </div>
                          <div className="col">
                            <div className="mono">
                              {issue.issueStage === "pick_scan" ? "товар" : "баркод"}: {issue.orderBarcode || "—"}
                            </div>
                            <div className="mono">шк: {issue.scannedBarcode || "—"}</div>
                          </div>
                          <div className="col">
                            {issue.createdAt ? new Date(issue.createdAt).toLocaleString("ru-RU") : "—"}
                          </div>
                          <div className="col right actions">
                            <button
                              className="ghost-button small"
                              type="button"
                              onClick={() => handleResolveScanIssue(issue.id)}
                              disabled={scanIssueActionBusyId === issue.id}
                            >
                              Решена
                            </button>
                            <button
                              className="primary-button small"
                              type="button"
                              onClick={() => handleFixScanIssue(issue.id)}
                              disabled={scanIssueActionBusyId === issue.id}
                            >
                              {issue.issueStage === "pick_scan" ? "Разрешить без шк" : "Фикс"}
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </>
            )}
          </>
        ) : tab === "employees" ? (
          <>
            <div className="section-header">
              <div className="section-title">Сотрудники</div>
              <div className="hint">Логин и пароль берутся из общей базы сотрудников, здесь задаётся только доступ к WB.</div>
            </div>
            <div className="form-grid">
              <label className="field">
                <span>Сотрудник</span>
                <UserDirectoryPicker
                  value={createExternalUserId}
                  onChange={setCreateExternalUserId}
                  options={userDirectory.filter((entry) => !entry.alreadyAdded)}
                  loading={userDirectoryLoading}
                  disabled={userDirectoryLoading || userActionBusy}
                />
              </label>
              <label className="field">
                <span>Роль</span>
                <input className="input" value="Упаковщик" readOnly />
              </label>
              <div className="field">
                <span>&nbsp;</span>
                <button
                  className="primary-button"
                  type="button"
                  onClick={handleCreateUser}
                  disabled={userActionBusy || userDirectoryLoading}
                >
                  Добавить
                </button>
              </div>
            </div>

            {userDirectoryError && <div className="alert small">{userDirectoryError}</div>}
            {userActionError && <div className="alert small">{userActionError}</div>}
            {usersError && <div className="alert small">{usersError}</div>}

            <div className="list users">
              <div className="list-header">
                <div className="col">Сотрудник</div>
                <div className="col">Логин</div>
                <div className="col">Роль</div>
                <div className="col">Создан</div>
                <div className="col right">Действия</div>
              </div>
              <div className="list-body">
                {usersLoading ? (
                  <div className="empty">Загрузка…</div>
                ) : users.length === 0 ? (
                  <div className="empty">Пока нет сотрудников</div>
                ) : (
                  users.map((user) => (
                    <div className="row" key={user.id}>
                      <div className="col">
                        <div className="primary">{displayUserName(user)}</div>
                      </div>
                      <div className="col mono">{user.login || "—"}</div>
                      <div className="col mono">Упаковщик</div>
                      <div className="col">{formatDate(user.createdAt)}</div>
                      <div className="col right actions">
                        <button className="primary-button small" type="button" onClick={() => openEmployeeStats(user)}>
                          Статистика
                        </button>
                        <button className="ghost-button small" type="button" onClick={() => openEditUser(user)}>
                          Редактировать
                        </button>
                        <button className="ghost-button small danger" type="button" onClick={() => handleDeleteUser(user)}>
                          Удалить
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        ) : tab === "fbs_stock" ? (
          <>
            <div className="actions">
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
                  {fbsStockProgress.current?.barcode
                    ? `Сейчас: ${fbsStockProgress.current.productName || "—"} • баркод ${fbsStockProgress.current.barcode} • нужно ${Number(fbsStockProgress.current.requiredQty || 0)}`
                    : "Подготовка данных для проверки..."}
                </div>
              </div>
            ) : null}
            {fbsStockError ? <div className="alert">{fbsStockError}</div> : null}
            <div className="list fbs-stock">
              <div className="list-header">
                <div className="col">Название</div>
                <div className="col">Баркод</div>
                <div className="col">Артикул продавца</div>
                <div className="col right">{allStores[0]?.name || "Магазин 1"}</div>
                <div className="col right">{allStores[1]?.name || "Магазин 2"}</div>
                <div className="col right">Всего</div>
                <div className="col right">Остаток</div>
                <div className="col">Ячейка</div>
                <div className="col">Статус</div>
              </div>
              <div className="list-body">
                {(fbsStockLoading || (fbsStockRefreshing && fbsStockItems.length === 0)) ? (
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
                        <div className="muted">WB: {formatFbsValueList(item.nmIds?.length ? item.nmIds : item.nmId)}</div>
                      </div>
                      <div className="col mono">{formatFbsValueList(item.barcodes?.length ? item.barcodes : item.barcode)}</div>
                      <div className="col mono">{formatFbsValueList(item.articles?.length ? item.articles : item.article)}</div>
                      <div className="col right mono">{allStores[0] ? item.byStore?.[allStores[0].id] || 0 : 0}</div>
                      <div className="col right mono">{allStores[1] ? item.byStore?.[allStores[1].id] || 0 : 0}</div>
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
          </>
        ) : tab === "stock_problems" ? (
          <>
            <div className="actions">
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
          </>
        ) : booting ? (
          <div className="empty">Загрузка данных…</div>
        ) : tab === "new" ? (
          <>
          <div className="actions">
            <div className="actions-left">
              <button
                className="ghost-button"
                type="button"
                onClick={() => setNewItemsOpen(true)}
                disabled={newItems.length === 0}
              >
                Товары из новых
              </button>
              <div className="hint">Сводка по товарам и экспорт в Excel.</div>
            </div>
          </div>
          <div className="list orders new-orders">
            <div className="list-header">
              <div className="col check" />
              <div className="col">Заказ</div>
              <div className="col">Название</div>
              <div className="col">Баркод</div>
              <div className="col">Артикул продавца</div>
              <div className="col">Артикул WB</div>
              <div className="col right">Создан</div>
            </div>
            <div className="list-body">
              {newOrders.length === 0 ? (
                <div className="empty">Нет новых сборочных заданий</div>
              ) : (
                pagedOrders.map((order) => (
                  <div className="row" key={order.id}>
                    <div className="col check">
                      <input type="checkbox" aria-label="Выбрать" />
                    </div>
                    <div className="col">
                      <div className="primary">{order.id}</div>
                      <div className="muted">{formatDate(order.createdAt)}</div>
                    </div>
                    <div className="col">
                      <div className="primary">{order.productName || "—"}</div>
                    </div>
                    <div className="col mono">{order.barcode || "—"}</div>
                    <div className="col mono">{order.article || "—"}</div>
                    <div className="col mono">{order.nmId || "—"}</div>
                    <div className="col right">
                      <span className="pill">{timeAgo(order.createdAt)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          {newOrders.length > 0 && (
            <div className="pagination">
              <div className="page-info">
                Показано <strong>{pageFrom}–{pageTo}</strong> из {newOrders.length}
              </div>
              <div className="page-controls">
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => setPage(Math.max(1, safePage - 1))}
                  disabled={safePage === 1}
                >
                  Назад
                </button>
                <div className="page-indicator">
                  Стр. {safePage} / {totalPages}
                </div>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => setPage(Math.min(totalPages, safePage + 1))}
                  disabled={safePage === totalPages}
                >
                  Вперёд
                </button>
              </div>
            </div>
          )}
          </>
        ) : (
          <div className="list supplies">
            <div className="list-header">
              <div className="col check" />
              <div className="col">Поставка</div>
              <div className="col">QR-код поставки</div>
              <div className="col right">Кол-во заказов</div>
            </div>
            <div className="list-body">
              {supplies.length === 0 ? (
                <div className="empty">Нет поставок на сборке</div>
              ) : (
                supplies.map((supply) => (
                  <button
                    className={`row row-button ${isSupplyCompleted(supply) ? "completed-supply" : ""}`}
                    key={supply.id}
                    type="button"
                    onClick={() => setSelectedSupply(supply)}
                  >
                    <div className="col check">
                      <input type="checkbox" aria-label="Выбрать" onClick={(e) => e.stopPropagation()} />
                    </div>
                    <div className="col">
                      <div className="primary">{supply.name || `Поставка ${supply.id}`}</div>
                      <div className="muted">
                        {formatDate(supply.createdAt)}
                        {supplyAccessLabel(supply) ? ` \u00b7 ${supplyAccessLabel(supply)}` : ""}
                      </div>
                      {isSupplyCompleted(supply) ? (
                        <div className="supply-status-glow">Собрана</div>
                      ) : null}
                    </div>
                    <div className="col mono">{supply.id}</div>
                    <div className="col right">
                      <span className="count">{supply.orderCount ?? 0}</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </section>

      {selectedSupply && (
        <div className="modal-backdrop" onClick={() => setSelectedSupply(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">
                  Поставка {selectedSupply.id}
                  {supplyTotals.total > 0 && supplyTotals.remaining === 0 ? (
                    <span className="modal-status-glow">Собрана</span>
                  ) : null}
                </div>
                <div className="modal-subtitle">
                  {supplyTab === "items"
                    ? "Товары в поставке"
                    : supplyTab === "settings"
                    ? "Настройки поставки"
                    : "Заказы в поставке"}
                  {supplyTotals.total > 0 && supplyTotals.remaining === 0 ? " • Поставка полностью собрана" : ""}
                </div>
              </div>
              <div className="modal-actions-inline">
                {supplyTab === "items" && (
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={handleExportItems}
                    disabled={supplyItems.length === 0}
                  >
                    Экспорт в Excel
                  </button>
                )}
                <button className="icon-button" onClick={() => setSelectedSupply(null)} type="button">
                  {"\u00d7"}
                </button>
              </div>
            </div>

            <div className="modal-tabs">
              <button
                className={`modal-tab ${supplyTab === "orders" ? "active" : ""}`}
                type="button"
                onClick={() => setSupplyTab("orders")}
              >
                Заказы
              </button>
              <button
                className={`modal-tab ${supplyTab === "items" ? "active" : ""}`}
                type="button"
                onClick={() => setSupplyTab("items")}
              >
                Товары
              </button>
              <button
                className={`modal-tab ${supplyTab === "settings" ? "active" : ""}`}
                type="button"
                onClick={() => setSupplyTab("settings")}
              >
                Настройка
              </button>
            </div>

            <div className="modal-body">
            {supplyTab === "settings" ? (
              supplySettingsLoading && !supplySettings ? (
                <div className="empty">Загрузка настроек…</div>
              ) : supplySettingsError ? (
                <div className="empty error">{supplySettingsError}</div>
              ) : (
                <>
                  {supplySettingsNotice ? <div className="alert success small">{supplySettingsNotice}</div> : null}
                  {supplySettingsLoading ? <div className="hint small">Обновляем настройки…</div> : null}
                  <div className="settings-card wb-sync-card">
                    <div className="section-title">Актуализация из Wildberries</div>
                    <div className="hint small">
                      Поставка не подтягивает изменения из кабинета WB автоматически. Проверьте, изменился ли состав заказов в Wildberries, и при необходимости обновите.
                    </div>
                    {syncError ? <div className="alert error small">{syncError}</div> : null}
                    {!syncDiff && syncStatus !== "checking" ? (
                      <div className="wb-sync-actions">
                        <button
                          type="button"
                          className="btn primary"
                          onClick={handleCheckSupplySync}
                          disabled={settingsBusy || syncStatus === "fullApplying"}
                        >
                          Проверить изменения
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={handleApplyFullSupplySync}
                          disabled={settingsBusy || syncStatus === "fullApplying"}
                        >
                          {syncStatus === "fullApplying" ? "Синхронизирую…" : "Полная синхронизация"}
                        </button>
                      </div>
                    ) : null}
                    {syncStatus === "checking" ? (
                      <div className="wb-sync-progress">
                        <div className="wb-sync-bar"><span /></div>
                        <div className="hint small">Запрашиваю Wildberries…</div>
                      </div>
                    ) : null}
                    {syncDiff ? (
                      <div className="wb-sync-diff">
                        <div className="wb-sync-summary">
                          В Wildberries: <strong>{syncDiff.wbCount}</strong> · У нас: <strong>{syncDiff.currentCount}</strong> · Совпадают: <strong>{syncDiff.unchangedCount}</strong>
                        </div>
                        {syncDiff.removed?.length === 0 && syncDiff.added?.length === 0 ? (
                          <div className="alert success small">Изменений нет — поставка актуальна.</div>
                        ) : (
                          <>
                            {syncDiff.removed?.length > 0 ? (
                              <div className="wb-sync-group">
                                <div className="wb-sync-group-title removed">Пропадут ({syncDiff.removed.length})</div>
                                {syncDiff.removed.map((o) => (
                                  <div key={o.orderId} className="wb-sync-row removed">
                                    <span className="wb-sync-badge">−</span>
                                    <span className="wb-sync-art">{o.article || "—"}</span>
                                    <span className="wb-sync-name">{o.productName || o.orderId}</span>
                                    {o.collected ? <span className="wb-sync-warn">уже собран</span> : null}
                                  </div>
                                ))}
                              </div>
                            ) : null}
                            {syncDiff.added?.length > 0 ? (
                              <div className="wb-sync-group">
                                <div className="wb-sync-group-title added">Есть только на WB ({syncDiff.added.length}), обычная синхронизация их не добавит</div>
                                {syncDiff.added.map((o) => (
                                  <div key={o.orderId} className="wb-sync-row added">
                                    <span className="wb-sync-badge">+</span>
                                    <span className="wb-sync-art">{o.article || "—"}</span>
                                    <span className="wb-sync-name">{o.productName || o.orderId}</span>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                            {syncDiff.removedCollectedCount > 0 ? (
                              <div className="alert error small">
                                Внимание: {syncDiff.removedCollectedCount} из пропадающих заказов уже собраны — они не будут удалены, проверьте вручную.
                              </div>
                            ) : null}
                            {syncDiff.canFullSync === false && syncDiff.fullSyncBlockedReason ? (
                              <div className="hint small">Полная синхронизация заблокирована: {syncDiff.fullSyncBlockedReason}</div>
                            ) : null}
                            <div className="wb-sync-actions">
                              <button type="button" className="btn" onClick={() => { setSyncDiff(null); setSyncStatus("idle"); }} disabled={syncStatus === "applying"}>
                                Отмена
                              </button>
                              <button
                                type="button"
                                className="btn"
                                onClick={handleApplyFullSupplySync}
                                disabled={syncStatus === "applying" || syncStatus === "fullApplying" || syncDiff.canFullSync === false}
                              >
                                {syncStatus === "fullApplying" ? "Синхронизирую…" : "Полная синхронизация"}
                              </button>
                              <button type="button" className="btn primary" onClick={handleApplySupplySync} disabled={syncStatus === "applying"}>
                                {syncStatus === "applying" ? "Применяю…" : "Убрать отсутствующие"}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>
                  <div className="settings-grid">
                    <div className="settings-card">
                    <div className="section-title">Доступ к поставке</div>
                    <div className="mode-toggle">
                      {[
                        { value: "hidden", label: "Скрыта" },
                        { value: "selected_split", label: "Выбранным с разделением" },
                      ].map((mode) => (
                        <button
                          key={mode.value}
                          type="button"
                          className={`chip ${supplyAccessMode === mode.value ? "active" : ""}`}
                          onClick={() => handleAccessModeChange(mode.value)}
                          disabled={settingsBusy}
                        >
                          {mode.label}
                        </button>
                      ))}
                    </div>
                    <div className="section">
                      <div className="section-title">Метод сборки упаковщиков</div>
                      <label className="employee-chip">
                        <input
                          type="checkbox"
                          checked={employeeWorkflowIsPicking}
                          onChange={(e) => handleEmployeeWorkflowModeChange(e.target.checked)}
                          disabled={settingsBusy}
                        />
                        <span>Новый метод: сначала сборка товара, потом упаковка заказов</span>
                      </label>
                      <div className="hint small">
                        {employeeWorkflowIsPicking
                          ? "Новый метод сохранён для этой поставки. После распределения сотрудников можно запускать сборку товара."
                          : "Старый метод сохранён для этой поставки. После старта упаковщики сразу переходят к заказам."}
                      </div>
                    </div>
                    <div className="section">
                      <div className="section-title">Метод работы с остатками</div>
                      <label className="employee-chip">
                        <input
                          type="checkbox"
                          checked={stockMethodEnabled}
                          onChange={(e) => handleStockMethodChange(e.target.checked)}
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

                    {supplyAccessMode === "selected_split" && (
                      <div className="section">
                        <div className="section-title">Сотрудники</div>
                        <div className="hint small">
                          Выбрано: {supplyAccessUsers.length}
                          {supplyEmployeeQuery.trim() ? ` • найдено: ${filteredSupplyEmployees.length}` : ""}
                        </div>
                        <label className="field employee-search-field">
                          <span>Поиск сотрудника</span>
                          <input
                            className="input"
                            value={supplyEmployeeQuery}
                            onChange={(e) => setSupplyEmployeeQuery(e.target.value)}
                            placeholder="Фамилия или имя"
                          />
                        </label>
                        <div className="employee-grid-shell">
                          <div className="employee-grid">
                            {supplyEmployees.length === 0 ? (
                              <div className="empty">Нет сотрудников</div>
                            ) : filteredSupplyEmployees.length === 0 ? (
                              <div className="empty">Ничего не найдено</div>
                            ) : (
                              filteredSupplyEmployees.map((user) => (
                                <label className="employee-chip" key={user.id}>
                                  <input
                                    type="checkbox"
                                    checked={supplyAccessUsers.includes(user.id)}
                                    onChange={(e) => {
                                      const next = e.target.checked
                                        ? Array.from(new Set([...supplyAccessUsers, user.id]))
                                        : supplyAccessUsers.filter((id) => id !== user.id);
                                      setSupplyAccessUsers(next);
                                    }}
                                  />
                                  <span>{user.surname} {user.name}</span>
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

                    {supplyAccessMode === "selected_split" && (
                      <div className="section">
                        <div className="section-title">Распределение</div>
                        <div className="settings-actions">
                          <button
                            className="primary-button"
                            type="button"
                            onClick={() => handleSplitSupply("split")}
                            disabled={settingsBusy || supplyAccessUsers.length === 0}
                          >
                            Разделить
                          </button>
                          <button
                            className="ghost-button"
                            type="button"
                            onClick={() => handleSplitSupply("redistribute")}
                            disabled={settingsBusy || supplyAccessUsers.length === 0 || !hasAssignments}
                          >
                            Перераздать
                          </button>
                        </div>
                        <div className="hint small">
                          {employeeWorkflowIsPicking && supplySettings?.employeeWorkflowStage === "pick_active"
                            ? "Сборка товара уже запущена: упаковщики видят этап подбора товара перед упаковкой."
                            : employeeWorkflowIsPicking && supplySettings?.employeeWorkflowStage === "pick_pending"
                            ? "После распределения нажмите «Начать сборку товара», чтобы открыть этап подбора товара упаковщикам."
                            : employeeWorkflowIsPicking
                            ? "Новый метод включён. После распределения запустите этап сборки товара для упаковщиков."
                            : "Старый метод включён: после старта упаковщики сразу переходят к сборке заказов."}
                        </div>
                        {employeeWorkflowIsPicking ? (
                          <button
                            className="primary-button"
                            type="button"
                            onClick={handleStartProductPicking}
                            disabled={settingsBusy || !hasAssignments || supplySettings?.employeeWorkflowStage === "pick_active"}
                          >
                            Начать сборку товара
                          </button>
                        ) : null}
                      </div>
                    )}

                    {supplyAccessMode !== "hidden" && (
                      <button
                        className="ghost-button small"
                        type="button"
                        onClick={handleResetAccess}
                        disabled={settingsBusy}
                      >
                        Скрыть поставку
                      </button>
                    )}
                    </div>

                    <div className="settings-card">
                      <div className="section-title">Этикетки</div>
                      <div className="progress">
                        <span style={{ width: `${labelsProgress}%` }} />
                      </div>
                      <div className="hint">
                        Загружено: {labelsLoaded} / {labelsTotal}
                      </div>
                      {supplySettings?.labelsStatus === "ready" && (
                        <div className="hint small success">Этикетки готовы</div>
                      )}
                      {supplySettings?.labelsStatus === "error" && supplySettings?.labelsError && (
                        <div className="alert small">{supplySettings.labelsError}</div>
                      )}
                      <button
                        className="primary-button"
                        type="button"
                        onClick={handleLoadLabels}
                        disabled={labelsBusy || supplySettings?.labelsStatus === "loading"}
                      >
                        Получить этикетки
                      </button>
                      {supplySettings?.labelsStatus === "loading" && (
                        <div className="hint small">Идёт загрузка…</div>
                      )}
                    </div>

                    <div className="settings-card">
                      <div className="section-title">Прогресс сотрудников</div>
                      <div className="workflow-progress-summary">
                        <WorkflowProgress
                          label="Сборка товаров"
                          done={supplyPickingProgress.done}
                          total={supplyPickingProgress.total}
                          tone="items"
                        />
                        <WorkflowProgress
                          label="Сборка заказов"
                          done={supplyTotals.collected}
                          total={supplyTotals.total}
                        />
                      </div>
                      {supplyTotals.total > 0 && supplyTotals.remaining === 0 && (
                        <div className="hint small success">Все собрано</div>
                      )}
                      <div className="progress-list">
                        {supplyProgress.length === 0 ? (
                          <div className="empty">Нет данных по сборке</div>
                        ) : (
                          supplyProgress.map((entry) => (
                            <div className="progress-row" key={entry.userId}>
                              <div className="primary">{entry.surname} {entry.name}</div>
                              <div className="progress-row-stages">
                                <WorkflowProgress
                                  label="Товары"
                                  done={entry.pickingCollected}
                                  total={entry.pickingTotal}
                                  tone="items"
                                />
                                <WorkflowProgress label="Заказы" done={entry.collected} total={entry.total} />
                              </div>
                              <div className="progress-row-actions">
                                <button
                                  className="ghost-button small"
                                  type="button"
                                  onClick={() => handleExportEmployeeSupplyItems(entry)}
                                  disabled={settingsBusy || Number(entry.total || 0) < 1}
                                >
                                  Экспорт товаров
                                </button>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                </>
              )
            ) : supplyLoading ? (
              <div className="empty">Загрузка…</div>
            ) : supplyError ? (
              <div className="empty error">{supplyError}</div>
            ) : supplyTab === "items" ? (
              <div className="list items compact supply-items-list">
                <div className="list-header">
                  <div className="col">Фото</div>
                  <div className="col">Название</div>
                  <div className="col">Баркод</div>
                  <div className="col">Артикул продавца</div>
                  <div className="col">Артикул WB</div>
                  <div className="col right">Кол-во</div>
                </div>
                <div className="list-body">
                  {supplyItems.length === 0 ? (
                    <div className="empty">Нет товаров в этой поставке</div>
                  ) : (
                    supplyItems.map((item) => (
                      <div className="row" key={`${item.name || "—"}-${item.barcode || "—"}-${item.article || "—"}-${item.nmId || "—"}`}>
                        <div className="col">
                          <AdminProductPhoto src={item.imageUrl} alt={item.name || "Фото товара"} />
                        </div>
                        <div className="col">
                          <div className="primary">{item.name || "—"}</div>
                        </div>
                        <div className="col mono">{item.barcode || "—"}</div>
                        <div className="col mono">{item.article || "—"}</div>
                        <div className="col mono">{item.nmId || "—"}</div>
                        <div className="col right">
                          <span className="count">{item.count}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <>
                <div className="actions">
                  <div className="actions-left">
                    <button
                      className="primary-button"
                      type="button"
                      disabled={supplyOrders.length === 0}
                      onClick={() => {
                        window.open(
                          `${API_BASE}/supplies/${encodeURIComponent(selectedSupply.id)}/labels.pdf`,
                          "_blank",
                          "noopener,noreferrer"
                        );
                      }}
                    >
                      Этикетки
                    </button>
                  </div>
                </div>
                <div className="list orders compact">
                  <div className="list-header">
                  <div className="col check" />
                  <div className="col">Заказ</div>
                  <div className="col">Артикул продавца</div>
                  <div className="col">Артикул WB</div>
                  <div className="col right">Создан</div>
                  </div>
                  <div className="list-body">
                  {supplyOrders.length === 0 ? (
                    <div className="empty">Нет заказов в этой поставке</div>
                  ) : (
                    supplyOrders.map((order) => (
                      <div className="row" key={order.id}>
                        <div className="col check">
                          <input type="checkbox" aria-label="Выбрать" />
                        </div>
                        <div className="col">
                          <div className="primary">{order.id}</div>
                          <div className="muted">{formatDate(order.createdAt)}</div>
                        </div>
                        <div className="col mono">{order.article || "—"}</div>
                        <div className="col mono">{order.nmId || "—"}</div>
                        <div className="col right">
                          <span className="pill">{timeAgo(order.createdAt)}</span>
                        </div>
                      </div>
                    ))
                  )}
                  </div>
                </div>
              </>
            )}
            </div>
          </div>
        </div>
      )}

      {newItemsOpen && (
        <div className="modal-backdrop" onClick={() => setNewItemsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Товары из новых</div>
                <div className="modal-subtitle">Сводка по товарам во вкладке «Новые»</div>
              </div>
              <div className="modal-actions-inline">
                <button
                  className="ghost-button"
                  type="button"
                  onClick={newItemsTab === "all" ? handleExportAllItems : handleExportNewItems}
                  disabled={newItemsTab === "all" ? allStoreItems.length === 0 : newItems.length === 0}
                >
                  Экспорт в Excel
                </button>
                <button className="icon-button" onClick={() => setNewItemsOpen(false)} type="button">
                  {"\u00d7"}
                </button>
              </div>
            </div>
            <div className="modal-tabs">
              <button
                className={`modal-tab ${newItemsTab === "current" ? "active" : ""}`}
                type="button"
                onClick={() => setNewItemsTab("current")}
              >
                Текущий магазин
              </button>
              <button
                className={`modal-tab ${newItemsTab === "all" ? "active" : ""}`}
                type="button"
                onClick={() => setNewItemsTab("all")}
              >
                Все магазины
              </button>
            </div>
            <div className="modal-body">
              {newItemsTab === "all" ? (
                <>
                  {newItemsAllError && <div className="alert small">{newItemsAllError}</div>}
                  <div className="list items compact preview">
                    <div className="list-header">
                      <div className="col">Название</div>
                      <div className="col">Баркод</div>
                      <div className="col">Артикул продавца</div>
                      <div className="col">Артикул WB</div>
                      <div className="col right">Итого</div>
                      <div className="col right">{allStores[0]?.name || "Магазин 1"}</div>
                      <div className="col right">{allStores[1]?.name || "Магазин 2"}</div>
                    </div>
                    <div className="list-body">
                      {newItemsAllLoading ? (
                        <div className="empty">Загрузка…</div>
                      ) : allStoreItems.length === 0 ? (
                        <div className="empty">Нет новых товаров</div>
                      ) : (
                        allStoreItems.map((item) => (
                          <div
                            className="row"
                            key={`${item.name || "—"}-${item.barcode || "—"}-${item.article || "—"}-${item.nmId || "—"}`}
                          >
                            <div className="col">
                              <div className="primary">{item.name || "—"}</div>
                            </div>
                            <div className="col mono">{item.barcode || "—"}</div>
                            <div className="col mono">{item.article || "—"}</div>
                            <div className="col mono">{item.nmId || "—"}</div>
                            <div className="col right">
                              <span className="count">{item.total}</span>
                            </div>
                            <div className="col right">
                              <span className="count">
                                {allStores[0] ? item.byStore?.[allStores[0].id] || 0 : 0}
                              </span>
                            </div>
                            <div className="col right">
                              <span className="count">
                                {allStores[1] ? item.byStore?.[allStores[1].id] || 0 : 0}
                              </span>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                  {newItemsAllUpdatedAt && (
                    <div className="hint">
                      Обновлено: {newItemsAllUpdatedAt.toLocaleTimeString("ru-RU")}
                    </div>
                  )}
                </>
              ) : (
                <div className="list items compact preview">
                  <div className="list-header">
                    <div className="col">Название</div>
                    <div className="col">Баркод</div>
                    <div className="col">Артикул продавца</div>
                    <div className="col">Артикул WB</div>
                    <div className="col right">Кол-во</div>
                  </div>
                  <div className="list-body">
                    {newItems.length === 0 ? (
                      <div className="empty">Нет новых товаров</div>
                    ) : (
                      newItems.map((item) => (
                        <div
                          className="row"
                          key={`${item.name || "—"}-${item.barcode || "—"}-${item.article || "—"}-${item.nmId || "—"}`}
                        >
                          <div className="col">
                            <div className="primary">{item.name || "—"}</div>
                          </div>
                          <div className="col mono">{item.barcode || "—"}</div>
                          <div className="col mono">{item.article || "—"}</div>
                          <div className="col mono">{item.nmId || "—"}</div>
                          <div className="col right">
                            <span className="count">{item.count}</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {createOpen && (
        <div className="modal-backdrop" onClick={() => setCreateOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Создать новую поставку</div>
                <div className="modal-subtitle">Быстрое добавление сборочных заданий</div>
              </div>
              <button className="icon-button" onClick={() => setCreateOpen(false)} type="button">
                {"\u00d7"}
              </button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <label className="field">
                  <span>Название поставки</span>
                  <input
                    className="input"
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    placeholder="Например: Сборка утро 05.02"
                  />
                </label>
              </div>

              <div className="section">
                <div className="section-title">Товары из вкладки «Новые»</div>
                <div className="list items compact preview">
                  <div className="list-header">
                    <div className="col">Название</div>
                    <div className="col">Баркод</div>
                    <div className="col">Артикул продавца</div>
                    <div className="col">Артикул WB</div>
                    <div className="col right">Кол-во</div>
                  </div>
                  <div className="list-body">
                    {newItems.length === 0 ? (
                      <div className="empty">Нет новых товаров</div>
                    ) : (
                      newItems.map((item) => (
                        <div
                          className="row"
                          key={`${item.name || "—"}-${item.barcode || "—"}-${item.article || "—"}-${item.nmId || "—"}`}
                        >
                          <div className="col">
                            <div className="primary">{item.name || "—"}</div>
                          </div>
                          <div className="col mono">{item.barcode || "—"}</div>
                          <div className="col mono">{item.article || "—"}</div>
                          <div className="col mono">{item.nmId || "—"}</div>
                          <div className="col right">
                            <span className="count">{item.count}</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              <div className="section">
                <div className="section-title">Режим создания</div>
                <div className="mode-toggle">
                  <button
                    type="button"
                    className={`chip ${createMode === "count" ? "active" : ""}`}
                    onClick={() => setCreateMode("count")}
                  >
                    По количеству
                  </button>
                  <button
                    type="button"
                    className={`chip ${createMode === "articles" ? "active" : ""}`}
                    onClick={() => setCreateMode("articles")}
                  >
                    По артикулам
                  </button>
                </div>
              </div>

              {createMode === "count" ? (
                <div className="form-grid">
                  <label className="field">
                    <span>Количество заказов</span>
                    <input
                      className="input"
                      type="number"
                      min="1"
                      value={createCount}
                      onChange={(e) => setCreateCount(e.target.value)}
                    />
                    <div className="chips">
                      {[10, 25, 50, 100, 200, 300].map((value) => (
                        <button
                          key={value}
                          type="button"
                          className={`chip ${safeCreateCount === value ? "active" : ""}`}
                          onClick={() => setCreateCount(value)}
                        >
                          {value}
                        </button>
                      ))}
                    </div>
                  </label>

                  <label className="field">
                    <span>Сортировка</span>
                    <select
                      className="input"
                      value={createSort}
                      onChange={(e) => setCreateSort(e.target.value)}
                    >
                      <option value="newest">Самые новые</option>
                      <option value="oldest">Самые старые</option>
                    </select>
                  </label>
                </div>
              ) : (
                <div className="section">
                  <div className="section-title">Выбор артикулов</div>
                  <div className="article-rows">
                    {articleRows.map((row) => {
                      const isDuplicate = row.article
                        ? articleRows.some((item) => item.id !== row.id && item.article === row.article)
                        : false;
                      const available =
                        row.article && articleSelection.availableByArticle.get(row.article)
                          ? articleSelection.availableByArticle.get(row.article)
                          : 0;
                      const max = Math.max(0, available || 0);
                      const isDisabled = max === 0;
                      return (
                        <div className="article-row" key={row.id}>
                          <label className="field">
                            <span>Артикул продавца</span>
                            <input
                              className={`input ${isDuplicate ? "input-error" : ""}`}
                              list="article-list"
                              value={row.article}
                              placeholder="Введите артикул"
                              onChange={(e) => {
                                const nextArticle = e.target.value.trim();
                                setArticleRows((rows) =>
                                  rows.map((item) =>
                                    item.id === row.id
                                      ? { ...item, article: nextArticle, count: nextArticle ? 1 : 0 }
                                      : item
                                  )
                                );
                              }}
                            />
                            {isDuplicate && (
                              <div className="hint small error">Артикул уже выбран в другой строке</div>
                            )}
                          </label>

                          <label className="field">
                            <span>Кол-во заказов</span>
                            <input
                              className="input"
                              type="number"
                              min={isDisabled ? 0 : 1}
                              max={max}
                              value={Math.min(row.count, max)}
                              onChange={(e) => {
                                const value = Number(e.target.value) || 0;
                                const next = Math.min(Math.max(value, isDisabled ? 0 : 1), max);
                                setArticleRows((rows) =>
                                  rows.map((item) =>
                                    item.id === row.id ? { ...item, count: next } : item
                                  )
                                );
                              }}
                              disabled={isDisabled}
                            />
                            <div className="hint small">Доступно: {available}</div>
                          </label>

                          <label className="field">
                            <span>Сортировка</span>
                            <select
                              className="input"
                              value={row.sortDir}
                              onChange={(e) =>
                                setArticleRows((rows) =>
                                  rows.map((item) =>
                                    item.id === row.id ? { ...item, sortDir: e.target.value } : item
                                  )
                                )
                              }
                            >
                              <option value="newest">Самые новые</option>
                              <option value="oldest">Самые старые</option>
                            </select>
                          </label>

                          <button
                            className="ghost-button small"
                            type="button"
                            onClick={() =>
                              setArticleRows((rows) => rows.filter((item) => item.id !== row.id))
                            }
                            disabled={articleRows.length === 1}
                          >
                            Удалить
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <datalist id="article-list">
                    {articleOptions.map((option) => (
                      <option key={option.article} value={option.article}>
                        {option.name ? `${option.article} — ${option.name}` : option.article}
                      </option>
                    ))}
                  </datalist>
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() =>
                      setArticleRows((rows) => [
                        ...rows,
                        { id: rowIdRef.current++, article: "", count: 1, sortDir: "newest" },
                      ])
                    }
                  >
                    Добавить товар
                  </button>
                </div>
              )}

              <div className="preview">
                {createMode === "count" ? (
                  <>
                    <div className="preview-row">
                      <span>Запрошено</span>
                      <span>{requestedCount}</span>
                    </div>
                    <div className="preview-row">
                      <span>Будет выбрано</span>
                      <strong>{selection.selected.length}</strong>
                    </div>
                    <div className="preview-row">
                      <span>Доступно в группе</span>
                      <span>{selection.available}</span>
                    </div>
                    {selection.warehouseId != null && (
                      <div className="preview-row">
                        <span>Склад</span>
                        <span>{selection.warehouseId}</span>
                      </div>
                    )}
                    {selection.cargoType != null && (
                      <div className="preview-row">
                        <span>Тип габарита</span>
                        <span>{selection.cargoType}</span>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="preview-row">
                      <span>Запрошено заказов</span>
                      <span>{articleRequested}</span>
                    </div>
                    <div className="preview-row">
                      <span>Будет выбрано</span>
                      <strong>{articleSelection.selected.length}</strong>
                    </div>
                    {articleSelection.warehouseId != null && (
                      <div className="preview-row">
                        <span>Склад</span>
                        <span>{articleSelection.warehouseId}</span>
                      </div>
                    )}
                    {articleSelection.cargoType != null && (
                      <div className="preview-row">
                        <span>Тип габарита</span>
                        <span>{articleSelection.cargoType}</span>
                      </div>
                    )}
                  </>
                )}
                {hasLimitWarning ? (
                  <div className="alert warn">
                    Запрошено {requestedCount}, доступно {selectedCount}. WB не принимает разные
                    склады/типы в одной поставке — отбор делается автоматически по первой заявке.
                  </div>
                ) : (
                  <div className="preview-note">
                    WB не принимает разные склады/типы в одной поставке — отбор делается
                    автоматически по первой заявке.
                  </div>
                )}
              </div>

              {createError && <div className="alert small">{createError}</div>}

              <div className="modal-actions">
                <button className="ghost-button" onClick={() => setCreateOpen(false)} type="button">
                  Отмена
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={handleCreateSupply}
                  disabled={createBusy || !createName.trim() || !canCreate}
                >
                  {createBusy ? "Создаю…" : "Создать поставку"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editUser && (
        <div className="modal-backdrop" onClick={() => setEditUser(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Роль сотрудника</div>
                <div className="modal-subtitle">{displayUserName(editUser)}</div>
              </div>
              <button className="icon-button" onClick={() => setEditUser(null)} type="button">
                {"\u00d7"}
              </button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <label className="field">
                  <span>Логин</span>
                  <input className="input" value={editUser.login || ""} readOnly />
                </label>
                <label className="field">
                  <span>Роль на сайте</span>
                  <select className="input" value={editRole} onChange={(e) => setEditRole(e.target.value)}>
                    <option value="employee">Упаковщик</option>
                  </select>
                </label>
              </div>
              {userActionError && <div className="alert small">{userActionError}</div>}
              <div className="modal-actions">
                <button className="ghost-button" type="button" onClick={() => setEditUser(null)}>
                  Отмена
                </button>
                <button className="primary-button" type="button" onClick={handleSaveUser} disabled={userActionBusy}>
                  Сохранить
                </button>
              </div>
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
        onApplyCustomRange={applyEmployeeCustomStatsRange}
        onClose={closeEmployeeStats}
      />
    </div>
  );
}
export default App;
