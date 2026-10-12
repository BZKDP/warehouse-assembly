const MOSCOW_OFFSET = "+03:00";

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  if (minutes > 0) return `${minutes} мин ${secs} сек`;
  return `${secs} сек`;
}

function formatDateTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ru-RU");
}

function formatShortDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
}

function formatNumber(value, maximumFractionDigits = 1) {
  return new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(Number(value) || 0);
}

function getMoscowDateString() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function shiftDateString(dateString, days) {
  const date = new Date(`${dateString}T00:00:00${MOSCOW_OFFSET}`);
  if (Number.isNaN(date.getTime())) return dateString;
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function buildRange(rangeKey, customFrom, customTo) {
  const today = getMoscowDateString();
  let fromDate = customFrom;
  let toDate = customTo;
  if (rangeKey === "today") {
    fromDate = today;
    toDate = today;
  } else if (rangeKey === "7d") {
    fromDate = shiftDateString(today, -6);
    toDate = today;
  } else if (rangeKey === "30d") {
    fromDate = shiftDateString(today, -29);
    toDate = today;
  } else if (rangeKey === "month") {
    const [year, month] = today.split("-");
    fromDate = `${year}-${month}-01`;
    toDate = today;
  }
  if (!fromDate || !toDate) return { fromMs: null, toMs: null };
  const from = new Date(`${fromDate}T00:00:00${MOSCOW_OFFSET}`);
  const to = new Date(`${shiftDateString(toDate, 1)}T00:00:00${MOSCOW_OFFSET}`);
  return {
    fromMs: Number.isNaN(from.getTime()) ? null : from.getTime(),
    toMs: Number.isNaN(to.getTime()) ? null : to.getTime(),
  };
}

function hasPickingActivity(session) {
  return (
    Number(session?.pickingCollectedQty || 0) > 0 ||
    Number(session?.pickingTotalSeconds || 0) > 0 ||
    Boolean(session?.pickingStartedAt)
  );
}

function hasPackingActivity(session) {
  return (
    Number(session?.collectedOrderCount || 0) > 0 ||
    Number(session?.packingTotalSeconds || 0) > 0 ||
    Boolean(session?.startedAt)
  );
}

function sessionFitsRange(session, range) {
  if (!range?.fromMs || !range?.toMs) return true;
  const candidates = [session?.startedAt, session?.pickingStartedAt, session?.assignedAt]
    .map((value) => new Date(value || "").getTime())
    .filter((value) => Number.isFinite(value));
  if (!candidates.length) return false;
  return candidates.some((value) => value >= range.fromMs && value < range.toMs);
}

function formatUnitsPerHour(units, seconds, unitLabel) {
  const count = Number(units || 0);
  const totalSeconds = Number(seconds || 0);
  if (count <= 0 || totalSeconds <= 0) return "—";
  return `${formatNumber((count * 3600) / totalSeconds)} ${unitLabel}/ч`;
}

function formatUnitsPerSession(units, sessionsCount, unitLabel) {
  const count = Number(units || 0);
  const sessions = Number(sessionsCount || 0);
  if (count <= 0 || sessions <= 0) return "—";
  return `${formatNumber(count / sessions)} ${unitLabel}`;
}

function formatSecondsPerUnit(seconds, units, unitLabel) {
  const count = Number(units || 0);
  const totalSeconds = Number(seconds || 0);
  if (count <= 0 || totalSeconds <= 0) return "—";
  return `${formatDuration(totalSeconds / count)} / ${unitLabel}`;
}

function getSessionStatusLabel(session) {
  if (session?.status === "finished") return "Завершена";
  if (session?.status === "started") return "В работе";
  if (session?.status === "cancelled") return "Остановлена";
  if (session?.status === "assigned") return "Назначена";
  return session?.status || "—";
}

function SummaryCard({ title, primary, secondary, tertiary, tone = "neutral" }) {
  return (
    <div className={`employee-stats-v1-summary-card tone-${tone}`}>
      <div className="employee-stats-v1-summary-title">{title}</div>
      <div className="employee-stats-v1-summary-primary">{primary}</div>
      <div className="employee-stats-v1-summary-lines">
        {secondary ? <div>{secondary}</div> : null}
        {tertiary ? <div>{tertiary}</div> : null}
      </div>
    </div>
  );
}

function AverageCard({ title, itemAverage, orderAverage, footer, tone = "neutral" }) {
  return (
    <div className={`employee-stats-v1-average-card tone-${tone}`}>
      <div className="employee-stats-v1-average-title">{title}</div>
      <div className="employee-stats-v1-average-grid">
        <div className="employee-stats-v1-average-row">
          <span>1 товар</span>
          <strong>{itemAverage}</strong>
        </div>
        <div className="employee-stats-v1-average-row">
          <span>1 заказ</span>
          <strong>{orderAverage}</strong>
        </div>
      </div>
      {footer ? <div className="employee-stats-v1-average-footer">{footer}</div> : null}
    </div>
  );
}

function StageMetric({ label, value, hint }) {
  return (
    <div className="employee-stats-v1-stage-metric">
      <div className="employee-stats-v1-stage-metric-label">{label}</div>
      <div className="employee-stats-v1-stage-metric-value">{value}</div>
      {hint ? <div className="employee-stats-v1-stage-metric-hint">{hint}</div> : null}
    </div>
  );
}

function StageCard({
  title,
  accent = "pick",
  periodValue,
  periodHint,
  todayValue,
  allTimeValue,
  sessionCount,
  metrics,
}) {
  return (
    <section className={`employee-stats-v1-stage employee-stats-v1-stage-${accent}`}>
      <div className="employee-stats-v1-stage-top">
        <div>
          <div className="employee-stats-v1-stage-kicker">{title}</div>
          <div className="employee-stats-v1-stage-main">{periodValue}</div>
          <div className="employee-stats-v1-stage-note">{periodHint}</div>
        </div>
        <div className="employee-stats-v1-stage-pills">
          <span className="employee-stats-v1-mini-pill">Сегодня: {todayValue}</span>
          <span className="employee-stats-v1-mini-pill">Все время: {allTimeValue}</span>
          <span className="employee-stats-v1-mini-pill">Сессий: {sessionCount}</span>
        </div>
      </div>
      <div className="employee-stats-v1-stage-grid">
        {metrics.map((metric) => (
          <StageMetric key={metric.label} label={metric.label} value={metric.value} hint={metric.hint} />
        ))}
      </div>
    </section>
  );
}

function DailyRow({ day }) {
  const totalSeconds = Number(day?.totalSeconds || 0);
  const pickingSeconds = Number(day?.pickingSeconds || 0);
  const packingSeconds = Number(day?.packingSeconds || 0);
  const shareBase = Math.max(1, totalSeconds);
  const pickWidth = Math.max(0, Math.min(100, (pickingSeconds / shareBase) * 100));
  const packWidth = Math.max(0, Math.min(100, (packingSeconds / shareBase) * 100));

  return (
    <div className="employee-stats-v1-day-row">
      <div className="employee-stats-v1-day-meta">
        <div className="employee-stats-v1-day-date">{formatShortDate(day.day)}</div>
        <div className="employee-stats-v1-day-orders">{Number(day.orders || 0)} заказов</div>
      </div>
      <div className="employee-stats-v1-day-bar">
        <span className="segment-pick" style={{ width: `${pickWidth}%` }} />
        <span className="segment-pack" style={{ width: `${packWidth}%` }} />
      </div>
      <div className="employee-stats-v1-day-stats">
        <span>Товар: {formatDuration(pickingSeconds)}</span>
        <span>Заказы: {formatDuration(packingSeconds)}</span>
        <strong>{formatDuration(totalSeconds)}</strong>
      </div>
    </div>
  );
}

function SessionCard({ session }) {
  const pickAverage = formatSecondsPerUnit(session.pickingTotalSeconds, session.pickingCollectedQty, "товар");
  const packAverage = formatSecondsPerUnit(session.packingTotalSeconds, session.collectedOrderCount, "заказ");

  return (
    <article className="employee-stats-v1-session-card">
      <div className="employee-stats-v1-session-head">
        <div className="employee-stats-v1-session-title-wrap">
          <div className="employee-stats-v1-session-title">{session.supplyName || `Поставка ${session.supplyId}`}</div>
          <div className="employee-stats-v1-session-subtitle">
            <span className="mono">{session.supplyId}</span>
            <span>{session.storeName || "Без магазина"}</span>
          </div>
        </div>
        <span className={`employee-stats-v1-session-status status-${String(session.status || "").toLowerCase()}`}>
          {getSessionStatusLabel(session)}
        </span>
      </div>

      <div className="employee-stats-v1-session-meta">
        <div>
          <span>Назначил</span>
          <strong>{session.assignedByName || "—"}</strong>
        </div>
        <div>
          <span>Выдано</span>
          <strong>{formatDateTime(session.assignedAt)}</strong>
        </div>
        <div>
          <span>Старт товара</span>
          <strong>{formatDateTime(session.pickingStartedAt)}</strong>
        </div>
        <div>
          <span>Старт заказов</span>
          <strong>{formatDateTime(session.startedAt)}</strong>
        </div>
        <div>
          <span>Финиш</span>
          <strong>{formatDateTime(session.finishedAt || session.pickingFinishedAt)}</strong>
        </div>
      </div>

      <div className="employee-stats-v1-session-grid">
        <div className="employee-stats-v1-session-stage stage-pick">
          <div className="employee-stats-v1-session-stage-title">Сборка товара</div>
          <div className="employee-stats-v1-session-stage-main">{Number(session.pickingCollectedQty || 0)} шт</div>
          <div className="employee-stats-v1-session-stage-note">{formatDuration(session.pickingTotalSeconds || 0)} суммарно</div>
          <div className="employee-stats-v1-session-stage-meta">
            <span>Среднее на 1 товар</span>
            <strong>{pickAverage}</strong>
          </div>
        </div>
        <div className="employee-stats-v1-session-stage stage-pack">
          <div className="employee-stats-v1-session-stage-title">Упаковка заказов</div>
          <div className="employee-stats-v1-session-stage-main">
            {Number(session.collectedOrderCount || 0)} / {Number(session.assignedOrderCount || 0)}
          </div>
          <div className="employee-stats-v1-session-stage-note">{formatDuration(session.packingTotalSeconds || 0)} суммарно</div>
          <div className="employee-stats-v1-session-stage-meta">
            <span>Среднее на 1 заказ</span>
            <strong>{packAverage}</strong>
          </div>
        </div>
        <div className="employee-stats-v1-session-stage stage-total">
          <div className="employee-stats-v1-session-stage-title">Итого</div>
          <div className="employee-stats-v1-session-stage-main">{formatDuration(session.totalSeconds || 0)}</div>
          <div className="employee-stats-v1-session-stage-note">
            {hasPickingActivity(session) && hasPackingActivity(session)
              ? "Товар + заказы"
              : hasPickingActivity(session)
                ? "Только товар"
                : "Только заказы"}
          </div>
          <div className="employee-stats-v1-session-stage-meta employee-stats-v1-session-stage-meta-total">
            <div>
              <span>1 товар</span>
              <strong>{pickAverage}</strong>
            </div>
            <div>
              <span>1 заказ</span>
              <strong>{packAverage}</strong>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

export default function AdminEmployeeStatsModal({
  employee,
  statsData,
  statsLoading,
  statsError,
  rangeKey,
  setRangeKey,
  customFrom,
  setCustomFrom,
  customTo,
  setCustomTo,
  onApplyCustomRange,
  onClose,
}) {
  if (!employee) return null;

  const stats = statsData?.stats || {};
  const today = stats.today || {};
  const allTime = stats.allTime || {};
  const period = stats.period || {};
  const sessions = Array.isArray(stats.sessions) ? stats.sessions : [];
  const daily = Array.isArray(stats.daily) ? stats.daily : [];
  const employeeRoleLabel = "Упаковщик";

  const selectedRange = buildRange(rangeKey, customFrom, customTo);
  const rangeSessions = sessions.filter((session) => sessionFitsRange(session, selectedRange));
  const visibleSessions = rangeSessions.slice(0, 24);
  const pickingSessionCount = rangeSessions.filter(hasPickingActivity).length;
  const packingSessionCount = rangeSessions.filter(hasPackingActivity).length;
  const activeDaily = daily.filter((day) => Number(day?.totalSeconds || 0) > 0 || Number(day?.orders || 0) > 0);
  const visibleDaily = [...(activeDaily.length ? activeDaily : daily)].slice(-14).reverse();

  const periodOrders = Number(period.orders || 0);
  const periodPickedItems = Number(period.pickedItems || 0);
  const todayOrders = Number(today.orders || 0);
  const todayPickedItems = Number(today.pickedItems || 0);
  const allTimeOrders = Number(allTime.orders || 0);
  const allTimePickedItems = Number(allTime.pickedItems || 0);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal employee-stats-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="modal-title">{employee.surname} {employee.name}</div>
            <div className="modal-subtitle">
              {employeeRoleLabel} • Новый обзор статистики • Часовой пояс {statsData?.timezone || "Europe/Moscow"}
            </div>
          </div>
          <button className="icon-button" type="button" onClick={onClose}>
            {"\u00D7"}
          </button>
        </div>

        <div className="employee-stats-toolbar">
          {[
            { key: "today", label: "Сегодня" },
            { key: "7d", label: "7 дней" },
            { key: "30d", label: "30 дней" },
            { key: "month", label: "Месяц" },
            { key: "custom", label: "Период" },
          ].map((item) => (
            <button
              key={item.key}
              type="button"
              className={`chip ${rangeKey === item.key ? "active" : ""}`}
              onClick={() => setRangeKey(item.key)}
            >
              {item.label}
            </button>
          ))}
          {rangeKey === "custom" ? (
            <div className="employee-range-inline">
              <input className="input" type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
              <input className="input" type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
              <button className="primary-button" type="button" onClick={onApplyCustomRange}>
                Применить
              </button>
            </div>
          ) : null}
        </div>

        <div className="modal-body employee-stats-body employee-stats-v1-body">
          {statsLoading ? (
            <div className="empty">Загрузка статистики...</div>
          ) : statsError ? (
            <div className="alert">{statsError}</div>
          ) : (
            <>
              <section className="employee-stats-v1-hero">
                <div className="employee-stats-v1-hero-main">
                  <div className="employee-stats-v1-eyebrow">Обзор работы за выбранный период</div>
                  <div className="employee-stats-v1-headline">
                    {periodOrders} заказов и {periodPickedItems} товаров
                  </div>
                  <div className="employee-stats-v1-hero-note">
                    {formatDuration(period.totalSeconds)} суммарного времени • {Number(period.supplies || 0)} поставок • {Number(period.sessions || 0)} сессий
                  </div>
                </div>
                <div className="employee-stats-v1-hero-aside">
                  <div className="employee-stats-v1-hero-badge">
                    Средняя упаковка: <strong>{formatDuration(period.avgSecondsPerOrder || 0)} / заказ</strong>
                  </div>
                  <div className="employee-stats-v1-hero-badge">
                    Средняя сборка товара: <strong>{formatDuration(period.avgPickSecondsPerItem || 0)} / товар</strong>
                  </div>
                </div>
              </section>

              <section className="employee-stats-v1-summary-grid">
                <SummaryCard
                  title="Сегодня"
                  primary={`${todayOrders} заказов`}
                  secondary={`Товар: ${todayPickedItems} шт`}
                  tertiary={`Время: ${formatDuration(today.totalSeconds || 0)}`}
                  tone="today"
                />
                <SummaryCard
                  title="Период"
                  primary={`${periodOrders} заказов`}
                  secondary={`Товар: ${periodPickedItems} шт`}
                  tertiary={`Время: ${formatDuration(period.totalSeconds || 0)}`}
                  tone="period"
                />
                <SummaryCard
                  title="Все время"
                  primary={`${allTimeOrders} заказов`}
                  secondary={`Товар: ${allTimePickedItems} шт`}
                  tertiary={`Время: ${formatDuration(allTime.totalSeconds || 0)}`}
                  tone="alltime"
                />
              </section>

              <section className="employee-stats-v1-average-overview">
                <div className="employee-stats-v1-section-head">
                  <div>
                    <div className="section-title">Среднее время</div>
                    <div className="hint">Среднее время на 1 товар и на 1 заказ в общем по выбранному периоду.</div>
                  </div>
                </div>
                <div className="employee-stats-v1-average-overview-grid">
                  <AverageCard
                    title="Сегодня"
                    itemAverage={formatSecondsPerUnit(today.pickingSeconds, todayPickedItems, "товар")}
                    orderAverage={formatSecondsPerUnit(today.packingSeconds, todayOrders, "заказ")}
                    footer={`Время: ${formatDuration(today.totalSeconds || 0)}`}
                    tone="today"
                  />
                  <AverageCard
                    title="Период"
                    itemAverage={formatSecondsPerUnit(period.pickingSeconds, periodPickedItems, "товар")}
                    orderAverage={formatSecondsPerUnit(period.packingSeconds, periodOrders, "заказ")}
                    footer={`Время: ${formatDuration(period.totalSeconds || 0)}`}
                    tone="period"
                  />
                  <AverageCard
                    title="Все время"
                    itemAverage={formatSecondsPerUnit(allTime.pickingSeconds, allTimePickedItems, "товар")}
                    orderAverage={formatSecondsPerUnit(allTime.packingSeconds, allTimeOrders, "заказ")}
                    footer={`Время: ${formatDuration(allTime.totalSeconds || 0)}`}
                    tone="alltime"
                  />
                </div>
              </section>

              <section className="employee-stats-v1-workflow">
                <StageCard
                  title="Сборка товара"
                  accent="pick"
                  periodValue={`${periodPickedItems} шт`}
                  periodHint={`${formatDuration(period.pickingSeconds || 0)} за период`}
                  todayValue={`${todayPickedItems} шт`}
                  allTimeValue={`${allTimePickedItems} шт`}
                  sessionCount={pickingSessionCount}
                  metrics={[
                    {
                      label: "Средняя скорость",
                      value: formatUnitsPerHour(periodPickedItems, period.pickingSeconds, "шт"),
                      hint: "Сколько товаров в час в среднем",
                    },
                    {
                      label: "На 1 товар",
                      value: formatSecondsPerUnit(period.pickingSeconds, periodPickedItems, "товар"),
                      hint: "Среднее время на один товар",
                    },
                    {
                      label: "Средне за сессию",
                      value: formatUnitsPerSession(periodPickedItems, pickingSessionCount, "шт"),
                      hint: "Среднее количество товаров за одну сессию",
                    },
                    {
                      label: "Все время",
                      value: formatUnitsPerHour(allTimePickedItems, allTime.pickingSeconds, "шт"),
                      hint: `${formatDuration(allTime.avgPickSecondsPerItem || 0)} / товар`,
                    },
                  ]}
                />

                <StageCard
                  title="Упаковка заказов"
                  accent="pack"
                  periodValue={`${periodOrders} заказов`}
                  periodHint={`${formatDuration(period.packingSeconds || 0)} за период`}
                  todayValue={`${todayOrders} заказов`}
                  allTimeValue={`${allTimeOrders} заказов`}
                  sessionCount={packingSessionCount}
                  metrics={[
                    {
                      label: "Средняя скорость",
                      value: formatUnitsPerHour(periodOrders, period.packingSeconds, "зак"),
                      hint: "Сколько заказов в час в среднем",
                    },
                    {
                      label: "На 1 заказ",
                      value: formatSecondsPerUnit(period.packingSeconds, periodOrders, "заказ"),
                      hint: "Среднее время на один заказ",
                    },
                    {
                      label: "Средне за сессию",
                      value: formatUnitsPerSession(periodOrders, packingSessionCount, "заказа"),
                      hint: "Среднее количество заказов за одну сессию",
                    },
                    {
                      label: "Все время",
                      value: formatUnitsPerHour(allTimeOrders, allTime.packingSeconds, "зак"),
                      hint: `${formatDuration(allTime.avgSecondsPerOrder || 0)} / заказ`,
                    },
                  ]}
                />
              </section>

              <section className="employee-stats-v1-section">
                <div className="employee-stats-v1-section-head">
                  <div>
                    <div className="section-title">Дневная активность</div>
                    <div className="hint">По каждому дню видно распределение времени между сборкой товара и упаковкой заказов.</div>
                  </div>
                </div>
                <div className="employee-stats-v1-day-list">
                  {visibleDaily.length === 0 ? (
                    <div className="empty">Нет активности за выбранный период</div>
                  ) : (
                    visibleDaily.map((day) => <DailyRow key={day.day} day={day} />)
                  )}
                </div>
              </section>

              <section className="employee-stats-v1-section">
                <div className="employee-stats-v1-section-head">
                  <div>
                    <div className="section-title">Последние сессии</div>
                    <div className="hint">Карточки показывают, как шла сборка товара и упаковка заказов по каждой поставке.</div>
                  </div>
                </div>
                <div className="employee-stats-v1-session-list">
                  {visibleSessions.length === 0 ? (
                    <div className="empty">Сессий пока нет</div>
                  ) : (
                    visibleSessions.map((session) => <SessionCard key={session.id} session={session} />)
                  )}
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
