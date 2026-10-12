import { useCallback, useEffect, useMemo, useState } from "react";

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

function sanitizeFilePart(value, fallback = "export") {
  const normalized = String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function formatDateTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ru-RU");
}

function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total - hours * 3600 - minutes * 60;
  if (hours > 0) return `${hours} ч ${minutes} мин ${secs} сек`;
  if (minutes > 0) return `${minutes} мин ${secs} сек`;
  return `${secs} сек`;
}

function saveWorkbook(XLSX, book, filename) {
  const data = XLSX.write(book, { bookType: "xlsx", type: "array" });
  const blob = new Blob([data], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function buildItemsSheet(XLSX, items) {
  const rows = (Array.isArray(items) ? items : []).map((item) => ({
    Название: item.productName || "",
    Баркод: item.barcode || "",
    "Артикул продавца": item.article || "",
    "Артикул WB": item.nmId || "",
    "Кол-во": Number(item.count || 0),
  }));
  const header = ["Название", "Баркод", "Артикул продавца", "Артикул WB", "Кол-во"];
  const sheet = XLSX.utils.json_to_sheet(rows, { header });
  sheet["!cols"] = [{ wch: 40 }, { wch: 20 }, { wch: 24 }, { wch: 18 }, { wch: 10 }];
  return sheet;
}

function getEmployeeExportState(stateMap, supplyId) {
  const state = stateMap[supplyId];
  if (state) return state;
  return {
    open: false,
    loading: false,
    loaded: false,
    error: "",
    employees: [],
  };
}

export default function CollectorView({
  currentUser,
  handleLogout,
  apiBase,
  employeePositionLabel,
}) {
  const [supplies, setSupplies] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyMap, setBusyMap] = useState({});
  const [employeeExports, setEmployeeExports] = useState({});

  const setBusy = useCallback((key, value) => {
    setBusyMap((prev) => {
      if (value) return { ...prev, [key]: true };
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const isBusyKey = useCallback((key) => Boolean(busyMap[key]), [busyMap]);

  const loadSupplies = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const data = await fetchJson(`${apiBase}/employee/collector/supplies`);
      setSupplies(Array.isArray(data?.supplies) ? data.supplies : []);
    } catch (err) {
      if (err?.status === 401) return;
      setError(err?.message || "Не удалось загрузить поставки сборщика");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    let active = true;
    loadSupplies();
    const timer = window.setInterval(() => {
      if (!active) return;
      loadSupplies({ silent: true });
    }, 8000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [loadSupplies]);

  const totalRemainingItems = useMemo(
    () => supplies.reduce((sum, supply) => sum + Number(supply?.remainingItems || 0), 0),
    [supplies]
  );

  const loadEmployeesForSupply = useCallback(async (supply, { force = false } = {}) => {
    if (!supply?.id) return [];
    const supplyId = supply.id;
    const current = getEmployeeExportState(employeeExports, supplyId);
    if (!force && current.loaded && current.employees.length > 0) {
      return current.employees;
    }

    setEmployeeExports((prev) => ({
      ...prev,
      [supplyId]: {
        ...getEmployeeExportState(prev, supplyId),
        loading: true,
        error: "",
      },
    }));

    try {
      const data = await fetchJson(
        `${apiBase}/employee/collector/supplies/${encodeURIComponent(supplyId)}/export/employees`
      );
      const employees = Array.isArray(data?.employees) ? data.employees : [];
      setEmployeeExports((prev) => ({
        ...prev,
        [supplyId]: {
          ...getEmployeeExportState(prev, supplyId),
          loading: false,
          loaded: true,
          error: "",
          employees,
        },
      }));
      await loadSupplies({ silent: true });
      return employees;
    } catch (err) {
      const message = err?.message || "Не удалось загрузить сотрудников по поставке";
      setEmployeeExports((prev) => ({
        ...prev,
        [supplyId]: {
          ...getEmployeeExportState(prev, supplyId),
          loading: false,
          loaded: false,
          error: message,
          employees: [],
        },
      }));
      throw err;
    }
  }, [apiBase, employeeExports, loadSupplies]);

  const handleExportCommon = useCallback(async (supply) => {
    if (!supply?.id) return;
    const key = `common:${supply.id}`;
    if (isBusyKey(key)) return;
    setNotice("");
    setError("");
    setBusy(key, true);
    try {
      const data = await fetchJson(
        `${apiBase}/employee/collector/supplies/${encodeURIComponent(supply.id)}/export`
      );
      const XLSX = await import("xlsx");
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, buildItemsSheet(XLSX, data?.items), "Товары");
      const total = (Array.isArray(data?.items) ? data.items : []).reduce(
        (sum, item) => sum + Number(item?.count || 0),
        0
      );
      const base = sanitizeFilePart(supply.name || `supply_${supply.id}`, `supply_${supply.id}`);
      saveWorkbook(XLSX, book, `${base}_${total}_общая.xlsx`);
      setNotice(`Скачан общий файл по поставке: ${supply.name || supply.id}`);
      await loadSupplies({ silent: true });
    } catch (err) {
      setError(err?.message || "Не удалось выгрузить общий Excel");
    } finally {
      setBusy(key, false);
    }
  }, [apiBase, isBusyKey, loadSupplies, setBusy]);

  const handleToggleEmployees = useCallback(async (supply) => {
    if (!supply?.id) return;
    const supplyId = supply.id;
    const current = getEmployeeExportState(employeeExports, supplyId);
    const nextOpen = !current.open;
    setEmployeeExports((prev) => ({
      ...prev,
      [supplyId]: {
        ...getEmployeeExportState(prev, supplyId),
        open: nextOpen,
      },
    }));
    if (nextOpen && (!current.loaded || current.error)) {
      try {
        await loadEmployeesForSupply(supply, { force: Boolean(current.error) });
      } catch {
        // Ignore lazy employee export preload failures until the user retries.
      }
    }
  }, [employeeExports, loadEmployeesForSupply]);

  const handleReloadEmployees = useCallback(async (supply) => {
    if (!supply?.id) return;
    try {
      await loadEmployeesForSupply(supply, { force: true });
    } catch {
      // Ignore explicit reload failures here; UI keeps the current error state.
    }
  }, [loadEmployeesForSupply]);

  const handleExportSingleEmployee = useCallback(async (supply, entry) => {
    if (!supply?.id || !entry?.userId) return;
    const key = `employee:${supply.id}:${entry.userId}`;
    if (isBusyKey(key)) return;
    setNotice("");
    setError("");
    setBusy(key, true);
    try {
      const XLSX = await import("xlsx");
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, buildItemsSheet(XLSX, entry.items || []), "Товары");
      const base = sanitizeFilePart(supply.name || `supply_${supply.id}`, `supply_${supply.id}`);
      const fullName = `${entry.surname || ""} ${entry.name || ""}`.trim() || `employee_${entry.userId}`;
      const safeName = sanitizeFilePart(fullName, `employee_${entry.userId}`);
      const total = Number(entry.itemCount || 0);
      saveWorkbook(XLSX, book, `${base}_${safeName}_${total}.xlsx`);
      setNotice(`Скачан файл сотрудника: ${fullName}`);
    } catch (err) {
      setError(err?.message || "Не удалось выгрузить файл сотрудника");
    } finally {
      setBusy(key, false);
    }
  }, [isBusyKey, setBusy]);

  const handleFinish = useCallback(async (supply) => {
    if (!supply?.id) return;
    const key = `finish:${supply.id}`;
    if (isBusyKey(key)) return;
    setNotice("");
    setError("");
    setBusy(key, true);
    try {
      await fetchJson(`${apiBase}/employee/collector/supplies/${encodeURIComponent(supply.id)}/finish`, {
        method: "POST",
      });
      setSupplies((prev) => prev.filter((item) => item.id !== supply.id));
      setNotice(`Поставка отмечена как собранная: ${supply.name || supply.id}`);
    } catch (err) {
      setError(err?.message || "Не удалось завершить поставку");
    } finally {
      setBusy(key, false);
    }
  }, [apiBase, isBusyKey, setBusy]);

  return (
    <div className="app collector-page">
      <header className="topbar collector-topbar">
        <div className="brand">
          <div className="dot" />
          <div>
            <div className="title">WB Склад</div>
            <div className="subtitle">Кабинет сборщика</div>
          </div>
        </div>
        <div className="topbar-right">
          <div className="user-chip">
            <div className="user-name">
              {currentUser?.surname} {currentUser?.name}
            </div>
            <div className="user-role">{employeePositionLabel?.("collector") || "Сборщик"}</div>
          </div>
          <button className="ghost-button small" type="button" onClick={handleLogout}>
            Выйти
          </button>
        </div>
      </header>

      {notice ? <div className="alert success">{notice}</div> : null}
      {error ? <div className="alert">{error}</div> : null}

      <section className="card collector-card">
        <div className="section-header collector-header">
          <div className="section-title">Актуальные поставки</div>
          <div className="hint">Доступно: {supplies.length} • Осталось товаров: {totalRemainingItems}</div>
        </div>

        <div className="collector-actions">
          <button className="ghost-button" type="button" onClick={() => loadSupplies()} disabled={loading}>
            {loading ? "Обновление..." : "Обновить список"}
          </button>
        </div>

        {loading ? (
          <div className="empty">Загрузка...</div>
        ) : supplies.length === 0 ? (
          <div className="empty">Нет активных поставок для сборщика</div>
        ) : (
          <div className="collector-list">
            {supplies.map((supply) => {
              const session = supply.session || null;
              const statusText = session ? "В работе" : "Не начата";
              const exportState = getEmployeeExportState(employeeExports, supply.id);

              return (
                <article className="collector-supply-card" key={supply.id}>
                  <div className="collector-card-top">
                    <div className="collector-title-wrap">
                      <div className="primary">{supply.name || `Поставка ${supply.id}`}</div>
                      <div className="muted mono">{supply.id}</div>
                      <div className="muted">{supply.storeName || "—"}</div>
                    </div>
                    <div className={`collector-status ${session ? "active" : ""}`}>{statusText}</div>
                  </div>

                  <div className="collector-metrics">
                    <div className="collector-metric">
                      <div className="collector-metric-label">Осталось товаров</div>
                      <div className="collector-metric-value">{Number(supply.remainingItems || 0)} шт</div>
                    </div>
                    <div className="collector-metric">
                      <div className="collector-metric-label">Осталось заказов</div>
                      <div className="collector-metric-value">{Number(supply.remainingOrders || 0)}</div>
                    </div>
                    <div className="collector-metric">
                      <div className="collector-metric-label">Упаковщиков</div>
                      <div className="collector-metric-value">{Number(supply.employees || 0)}</div>
                    </div>
                  </div>

                  <div className="collector-session">
                    <div className="muted">
                      {session
                        ? `Старт: ${formatDateTime(session.startedAt)}`
                        : "Сессия запустится при первом экспорте"}
                    </div>
                    <div className="muted">
                      {session ? `Время: ${formatDuration(session.totalSeconds)}` : "Время: —"}
                    </div>
                  </div>

                  <div className="collector-card-actions">
                    <button
                      className="ghost-button small"
                      type="button"
                      onClick={() => handleExportCommon(supply)}
                      disabled={!supply.canExport || isBusyKey(`common:${supply.id}`)}
                    >
                      {isBusyKey(`common:${supply.id}`) ? "Выгрузка..." : "Экспорт общий"}
                    </button>
                    <button
                      className="ghost-button small"
                      type="button"
                      onClick={() => handleToggleEmployees(supply)}
                      disabled={!supply.canExport}
                    >
                      {exportState.open ? "Скрыть сотрудников" : "Сотрудники и экспорт"}
                    </button>
                    <button
                      className="primary-button small"
                      type="button"
                      onClick={() => handleFinish(supply)}
                      disabled={!supply.canFinish || isBusyKey(`finish:${supply.id}`)}
                    >
                      {isBusyKey(`finish:${supply.id}`) ? "Сохраняю..." : "Собрал"}
                    </button>
                  </div>

                  {exportState.open ? (
                    <div className="collector-employee-panel">
                      <div className="collector-employee-head">
                        <div className="collector-employee-title">Экспорт по сотрудникам</div>
                        <button
                          className="ghost-button small"
                          type="button"
                          onClick={() => handleReloadEmployees(supply)}
                          disabled={exportState.loading}
                        >
                          {exportState.loading ? "Обновляю..." : "Обновить"}
                        </button>
                      </div>

                      {exportState.loading ? (
                        <div className="hint">Загрузка сотрудников...</div>
                      ) : exportState.error ? (
                        <div className="hint text-danger">{exportState.error}</div>
                      ) : exportState.employees.length === 0 ? (
                        <div className="hint">Нет распределённых сотрудников</div>
                      ) : (
                        <div className="collector-employee-list">
                          {exportState.employees.map((entry) => {
                            const fullName =
                              `${entry.surname || ""} ${entry.name || ""}`.trim() ||
                              `ID ${entry.userId}`;
                            const busyKey = `employee:${supply.id}:${entry.userId}`;
                            const isBusy = isBusyKey(busyKey);
                            return (
                              <div className="collector-employee-row" key={`${supply.id}:${entry.userId}`}>
                                <div className="collector-employee-name">{fullName}</div>
                                <div className="collector-employee-count">
                                  {Number(entry.itemCount || 0)} шт • {Number(entry.orderCount || 0)} заказов
                                </div>
                                <button
                                  className="ghost-button small"
                                  type="button"
                                  onClick={() => handleExportSingleEmployee(supply, entry)}
                                  disabled={isBusy}
                                >
                                  {isBusy ? "Выгрузка..." : "Экспорт"}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
