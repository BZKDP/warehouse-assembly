function sessionStatusText(supply, session) {
  if (supply?.currentStage === "picking" || session?.activePhase === "picking") return "Сборка товара";
  if (supply?.currentStage === "waiting_admin") return "Ждёт запуска админом";
  if (supply?.currentStage === "picking_ready") return "Готова к сборке товара";
  if (supply?.canWork || (session?.startedAt && !session?.finishedAt)) return "Упаковка заказов";
  if (supply?.canStartPacking) return "Готова к упаковке";
  if (supply?.canStart) return "Готова к старту";
  if (supply?.hasAnotherActiveSession) return "Есть другая активная сборка";
  if (session?.finishedAt) return "Сессия завершена";
  return "Назначена";
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
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  if (minutes > 0) return `${minutes} мин`;
  return `${total} сек`;
}

function MetricCard({ label, value }) {
  return (
    <div className="employee-session-card">
      <div className="employee-session-label">{label}</div>
      <div className="employee-session-value">{value}</div>
    </div>
  );
}

function DetailRow({ label, value, mono = false }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong className={mono ? "mono" : ""}>{value}</strong>
    </div>
  );
}

function handleProductImageError(event) {
  const image = event.currentTarget;
  const sourceUrl = image.dataset.sourceUrl;
  const retryCount = Number(image.dataset.retryCount || 0);
  if (!sourceUrl || retryCount >= 3) {
    image.hidden = true;
    image.parentElement?.classList.add("is-missing");
    return;
  }
  const nextRetry = retryCount + 1;
  image.dataset.retryCount = String(nextRetry);
  window.setTimeout(() => {
    const separator = sourceUrl.includes("?") ? "&" : "?";
    image.src = `${sourceUrl}${separator}_image_retry=${Date.now()}`;
  }, nextRetry * 500);
}

function ProductImage({ src, alt = "Фото товара", detail = false }) {
  const openImage = (event) => {
    event.stopPropagation();
    if (src) window.open(src, "_blank", "noopener,noreferrer");
  };
  const handleKeyDown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openImage(event);
  };
  return (
    <span
      className={`product-photo${detail ? " product-photo--detail" : ""}${src ? "" : " is-missing"}`}
      role={src ? "button" : undefined}
      tabIndex={src ? 0 : undefined}
      title={src ? "Открыть фото товара" : undefined}
      onClick={openImage}
      onKeyDown={handleKeyDown}
    >
      <span className="product-photo-placeholder">Нет фото</span>
      {src ? (
        <img
          src={src}
          data-source-url={src}
          data-retry-count="0"
          alt={alt}
          loading="lazy"
          decoding="async"
          onLoad={(event) => {
            event.currentTarget.hidden = false;
            event.currentTarget.parentElement?.classList.remove("is-missing");
          }}
          onError={handleProductImageError}
        />
      ) : null}
    </span>
  );
}

function OrdersList({ orders, setEmployeeSelectedOrder, formatDate, timeAgo }) {
  return (
    <div className="list orders compact">
      <div className="list-header">
        <div className="col check" />
        <div className="col">Заказ</div>
        <div className="col">Артикул продавца</div>
        <div className="col">Артикул WB</div>
        <div className="col right">Создан</div>
      </div>
      <div className="list-body">
        {orders.length === 0 ? (
          <div className="empty">Нет заказов по этому товару</div>
        ) : (
          orders.map((order) => (
            <button className="row row-button" key={order.id} type="button" onClick={() => setEmployeeSelectedOrder(order)}>
              <div className="col check">
                <input type="checkbox" aria-label="Выбрать" onClick={(e) => e.stopPropagation()} />
              </div>
              <div className="col">
                <div className="product-with-photo">
                  <ProductImage src={order.imageUrl} alt={order.productName || `Заказ ${order.id}`} />
                  <div>
                    <div className="primary">{order.id}</div>
                    <div className="muted">{formatDate(order.createdAt)}</div>
                  </div>
                </div>
              </div>
              <div className="col mono">{order.article || "—"}</div>
              <div className="col mono">{order.nmId || "—"}</div>
              <div className="col right">
                <span className="pill">{timeAgo(order.createdAt)}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function ItemsList({ items, setEmployeeSelectedItem }) {
  return (
    <div className="list items compact">
      <div className="list-header">
        <div className="col">Название</div>
        <div className="col">Баркод</div>
        <div className="col">Артикул продавца</div>
        <div className="col">Артикул WB</div>
        <div className="col right">Кол-во</div>
      </div>
      <div className="list-body">
        {items.length === 0 ? (
          <div className="empty">Нет товаров в этой поставке</div>
        ) : (
          items.map((item) => (
            <button
              className="row row-button"
              key={`${item.productName || "—"}-${item.barcode || "—"}-${item.article || "—"}-${item.nmId || "—"}`}
              type="button"
              onClick={() => setEmployeeSelectedItem(item)}
            >
              <div className="col">
                <div className="product-with-photo">
                  <ProductImage src={item.imageUrl} alt={item.productName || "Фото товара"} />
                  <div className="primary">{item.productName || "—"}</div>
                </div>
              </div>
              <div className="col mono">{item.barcode || "—"}</div>
              <div className="col mono">{item.article || "—"}</div>
              <div className="col mono">{item.nmId || "—"}</div>
              <div className="col right">
                <span className="count">{item.count}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function PickItemsList({
  items,
  formatFbsCells,
  employeePickManualBusyId,
  handleEmployeePickCollectWithoutScan,
  pickItemsBodyRef,
}) {
  return (
    <div className="pick-items-board">
      <div className="pick-items-board-head">
        <div className="pick-items-head-title">Название</div>
        <div className="pick-items-head-title">Артикул</div>
        <div className="pick-items-head-title">Ячейка</div>
        <div className="pick-items-head-title right">Собрано</div>
      </div>
      <div className="pick-items-board-body" ref={pickItemsBodyRef}>
        {items.length === 0 ? (
          <div className="empty">Нет товаров для сборки</div>
        ) : (
          items.map((item) => (
            <div className="pick-item-card" key={item.itemKey || item.id} data-pick-item-id={item.id}>
              <div className="pick-item-main">
                <div className="product-with-photo">
                  <ProductImage src={item.imageUrl} alt={item.productName || "Фото товара"} />
                  <div>
                    <div className="pick-item-field-label">Название</div>
                    <div className="pick-item-name">{item.productName || "—"}</div>
                  </div>
                </div>
              </div>
              <div className="pick-item-meta mono">
                <div className="pick-item-field-label">Артикул продавца</div>
                <div className="pick-item-value">{item.article || "—"}</div>
              </div>
              <div className="pick-item-cell mono">
                <div className="pick-item-field-label">Ячейка</div>
                <div className="pick-item-cell-value">{formatFbsCells ? formatFbsCells(item.msCells) : "—"}</div>
              </div>
              <div className="pick-item-progress">
                <div className="pick-item-progress-top">
                  <div className="pick-item-field-label">Собрано</div>
                  <div className="pick-item-progress-value mono">{item.pickedQty || 0}/{item.requiredQty || 0}</div>
                </div>
                <div className="pick-item-progress-bar" aria-hidden="true">
                  <span
                    style={{
                      width: `${Math.max(
                        0,
                        Math.min(
                          100,
                          item.requiredQty > 0 ? (Number(item.pickedQty || 0) / Number(item.requiredQty || 0)) * 100 : 0
                        )
                      )}%`,
                    }}
                  />
                </div>
                {item.bypassWithoutScanAllowed && Number(item.remainingQty || 0) > 0 ? (
                  <button
                    className="ghost-button small pick-item-manual-button"
                    type="button"
                    onClick={() => handleEmployeePickCollectWithoutScan(item.id)}
                    disabled={employeePickManualBusyId === item.id}
                  >
                    {employeePickManualBusyId === item.id ? "Собираем..." : "Собрать без шк"}
                  </button>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function OrderDetail(props) {
  const {
    employeeSelectedOrder,
    employeeSelectedSupply,
    labelScanInputRef,
    labelScanValue,
    setLabelScanValue,
    labelOpened,
    labelScanBusy,
    labelScanError,
    scanInputRef,
    scanValue,
    setScanValue,
    scanBusy,
    scanError,
    handleCollectOrder,
    employeeCollectError,
    nextOrder,
    setEmployeeSelectedOrder,
    employeeIssueOpen,
    setEmployeeIssueOpen,
    employeeIssueInputRef,
    employeeIssueValue,
    setEmployeeIssueValue,
    employeeIssueBusy,
    employeeIssueError,
    setEmployeeIssueError,
    handleEmployeeIssueSubmit,
  } = props;

  return (
    <div className="order-detail">
      <ProductImage
        src={employeeSelectedOrder.imageUrl}
        alt={employeeSelectedOrder.productName || `Заказ ${employeeSelectedOrder.id}`}
        detail
      />
      <DetailRow label="Номер заказа" value={employeeSelectedOrder.id} />
      <DetailRow label="Магазин" value={employeeSelectedSupply?.storeName || "—"} />
      <DetailRow
        label="Дата и время"
        value={
          employeeSelectedOrder.createdAt
            ? new Date(employeeSelectedOrder.createdAt).toLocaleString("ru-RU")
            : "—"
        }
      />
      <DetailRow label="Название" value={employeeSelectedOrder.productName || "—"} />
      <DetailRow label="Баркод" value={employeeSelectedOrder.barcode || "—"} mono />
      <DetailRow label="Артикул продавца" value={employeeSelectedOrder.article || "—"} mono />
      <DetailRow label="Артикул WB" value={employeeSelectedOrder.nmId || "—"} mono />
      <DetailRow label="Количество" value={employeeSelectedOrder.quantity || 1} />
      {employeeSelectedOrder.scanPassed ? (
        <>
          <div className="scan-status success">Безошибочная сборка пройдена</div>
          {employeeSelectedOrder.labelScanPassed ? (
            <div className="scan-status success">Этикетка подтверждена</div>
          ) : (
            <div className="scan-block">
              <div className="field">
                <span>Штрихкод этикетки</span>
                <input
                  ref={labelScanInputRef}
                  className="input"
                  value={labelScanValue}
                  onChange={(e) => setLabelScanValue(e.target.value)}
                  placeholder="Отсканируйте этикетку"
                  disabled={!labelOpened || labelScanBusy}
                />
              </div>
              {!labelOpened ? <div className="hint small">Сначала откройте этикетку</div> : null}
              {labelScanError ? <div className="alert small">{labelScanError}</div> : null}
            </div>
          )}
        </>
      ) : (
        <div className="scan-block">
          <div className="field">
            <span>Штрихкод товара</span>
            <input
              ref={scanInputRef}
              className="input"
              value={scanValue}
              onChange={(e) => setScanValue(e.target.value)}
              placeholder="Отсканируйте штрихкод"
              disabled={scanBusy}
            />
          </div>
          {scanError ? <div className="alert small">{scanError}</div> : null}
        </div>
      )}
      <div className="detail-actions">
        <button
          className="primary-button"
          type="button"
          onClick={() => handleCollectOrder(employeeSelectedOrder)}
          disabled={!employeeSelectedOrder.stickerUrl || !employeeSelectedOrder.scanPassed}
        >
          {employeeSelectedOrder.stickerUrl ? "Открыть этикетку" : "Этикетка не загружена"}
        </button>
        {nextOrder ? (
          <button className="ghost-button" type="button" onClick={() => setEmployeeSelectedOrder(nextOrder)}>
            Далее
          </button>
        ) : null}
      </div>
      {employeeCollectError ? <div className="alert small">{employeeCollectError}</div> : null}
      {employeeIssueOpen ? (
        <div className="issue-overlay">
          <div className="issue-overlay-card">
            <div className="section-title">Ошибка безошибочной сборки</div>
            <div className="hint">Отсканируйте товар ещё раз. Админ увидит заказ, баркод и ваш штрихкод.</div>
            <div className="field">
              <span>Штрихкод товара</span>
              <input
                ref={employeeIssueInputRef}
                className="input"
                value={employeeIssueValue}
                onChange={(e) => setEmployeeIssueValue(e.target.value)}
                placeholder="Отсканируйте штрихкод"
                disabled={employeeIssueBusy}
              />
            </div>
            {employeeIssueError ? <div className="alert small">{employeeIssueError}</div> : null}
            <div className="detail-actions">
              <button
                className="primary-button small"
                type="button"
                onClick={() => {
                  if (!employeeSelectedOrder || !employeeIssueValue.trim()) return;
                  handleEmployeeIssueSubmit(employeeSelectedOrder, employeeIssueValue);
                }}
                disabled={employeeIssueBusy || !employeeIssueValue.trim()}
              >
                Отправить
              </button>
              <button
                className="ghost-button small"
                type="button"
                onClick={() => {
                  setEmployeeIssueError("");
                  setEmployeeIssueValue("");
                  setEmployeeIssueOpen(false);
                }}
                disabled={employeeIssueBusy}
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function EmployeeView(props) {
  const {
    currentUser,
    handleLogout,
    employeeSuppliesError,
    employeeSuppliesLoading,
    employeeSupplies,
    employeeSelectedSupply,
    setEmployeeSelectedSupply,
    employeeSelectedOrder,
    setEmployeeSelectedOrder,
    employeeSelectedItem,
    setEmployeeSelectedItem,
    employeePickItems,
    employeePickItemsLoading,
    employeePickItemsError,
    employeePickScanInputRef,
    handleEmployeePickScanInputBlur,
    employeePickScanValue,
    setEmployeePickScanValue,
    employeePickScanBusy,
    employeePickScanError,
    employeePickFinishBusy,
    employeePickFinishError,
    handleEmployeePickFinish,
    employeeOrders,
    employeeOrdersLoading,
    employeeOrdersError,
    employeeItems,
    employeeItemsLoading,
    employeeItemsError,
    employeeLookupInputRef,
    employeeLookupValue,
    setEmployeeLookupValue,
    employeeLookupBusy,
    employeeLookupError,
    employeeSupplySession,
    employeeSupplySessionLoading,
    employeeSupplySessionError,
    employeeStartBusy,
    employeeStartError,
    employeeFlowNotice,
    employeeFlowWarning,
    employeePickIssueOpen,
    setEmployeePickIssueOpen,
    employeePickIssueInputRef,
    employeePickIssueValue,
    setEmployeePickIssueValue,
    employeePickIssueItemId,
    setEmployeePickIssueItemId,
    employeePickIssueBusy,
    employeePickIssueError,
    setEmployeePickIssueError,
    handleEmployeePickIssueSubmit,
    employeePickManualBusyId,
    handleEmployeePickCollectWithoutScan,
    handleEmployeeStart,
    formatDate,
    formatFbsCells,
    timeAgo,
  } = props;

  const session = employeeSupplySession?.session || employeeSelectedSupply?.session || null;
  const workflow = employeeSupplySession?.workflow || {};
  const activeSession = employeeSupplySession?.activeSession || null;
  const supplyMeta = employeeSupplySession?.supply || employeeSelectedSupply || null;
  const assignedOrders = supplyMeta?.total ?? session?.assignedOrderCount ?? 0;
  const collectedOrders = supplyMeta?.collected ?? session?.collectedOrderCount ?? 0;
  const remainingOrders = supplyMeta?.remaining ?? Math.max(0, assignedOrders - collectedOrders);
  const currentStage = workflow?.currentStage || (employeeSupplySession?.canWork ? "packing" : "packing_ready");
  const isWaitingAdmin = currentStage === "waiting_admin";
  const isPicking = currentStage === "picking";
  const canStartPicking = Boolean(workflow?.canStartPicking);
  const canStartPacking = Boolean(workflow?.canStartPacking || (!workflow?.productPickingRequired && employeeSupplySession?.canStart));
  const pickRequiredQty = Number(session?.pickingRequiredQty || 0);
  const pickCollectedQty = Number(session?.pickingCollectedQty || 0);
  const pickRemainingQty = Math.max(0, Number(session?.pickingRemainingQty || pickRequiredQty - pickCollectedQty));
  const pickReadyToFinish = pickRequiredQty > 0 && pickRemainingQty === 0;
  const orderIndex =
    employeeSelectedOrder && employeeOrders.length
      ? employeeOrders.findIndex((order) => order.id === employeeSelectedOrder.id)
      : -1;
  const nextOrder = orderIndex >= 0 ? employeeOrders[orderIndex + 1] : null;

  const startTitle = workflow?.productPickingRequired && !session?.pickingFinishedAt ? "Сборка товара" : "Сессия сборки";
  const startHint = workflow?.productPickingRequired && !session?.pickingFinishedAt
    ? "Нажмите «Старт», чтобы открыть сборку товара перед упаковкой заказов."
    : workflow?.productPickingRequired && session?.pickingFinishedAt
    ? "Товары уже собраны. Нажмите «Старт», чтобы перейти к упаковке заказов."
    : "Нажмите «Старт», чтобы открыть заказы и начать работу с поставкой.";
  const startButtonText = canStartPicking ? "Старт сборки товара" : "Старт упаковки";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="dot" />
          <div>
            <div className="title">WB Склад</div>
            <div className="subtitle">Личный кабинет сотрудника</div>
          </div>
        </div>
        <div className="topbar-right">
          <div className="user-chip">
            <div className="user-name">{currentUser.surname} {currentUser.name}</div>
            <div className="user-role">Сотрудник</div>
          </div>
          <button className="ghost-button small" type="button" onClick={handleLogout}>
            Выйти
          </button>
        </div>
      </header>

      {employeeSuppliesError && <div className="alert">{employeeSuppliesError}</div>}

      <section className="card">
        <div className="section-header">
          <div className="section-title">Мои поставки</div>
          <div className="hint">Поставка становится рабочей только после запуска нужного этапа.</div>
        </div>
        <div className="list supplies">
          <div className="list-header">
            <div className="col check" />
            <div className="col">Поставка</div>
            <div className="col">ID</div>
            <div className="col">Статус</div>
            <div className="col right">Осталось</div>
          </div>
          <div className="list-body">
            {employeeSuppliesLoading ? (
              <div className="empty">Загрузка...</div>
            ) : employeeSupplies.length === 0 ? (
              <div className="empty">Нет активных поставок</div>
            ) : (
              employeeSupplies.map((supply) => (
                <button className="row row-button" key={supply.id} type="button" onClick={() => setEmployeeSelectedSupply(supply)}>
                  <div className="col check">
                    <input type="checkbox" aria-label="Выбрать" onClick={(e) => e.stopPropagation()} />
                  </div>
                  <div className="col">
                    <div className="primary">{supply.name || `Поставка ${supply.id}`}</div>
                    <div className="muted">
                      {supply.storeName ? `Магазин: ${supply.storeName} · ` : ""}
                      Назначено: {supply.total || 0}
                    </div>
                  </div>
                  <div className="col mono">{supply.id}</div>
                  <div className="col">
                    <span className={`pill ${supply.canWork || supply.currentStage === "picking" ? "active-pill" : ""}`}>
                      {sessionStatusText(supply, supply.session)}
                    </span>
                  </div>
                  <div className="col right">
                    <span className="count">{supply.remaining}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      </section>

      {employeeSelectedSupply ? (
        <div className="modal-backdrop" onClick={() => setEmployeeSelectedSupply(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">
                  Поставка {employeeSelectedSupply.id}
                  {employeeSelectedSupply.storeName ? ` · ${employeeSelectedSupply.storeName}` : ""}
                </div>
                <div className="modal-subtitle">
                  {employeeSelectedOrder
                    ? "Информация о заказе"
                    : employeeSelectedItem
                    ? "Заказы по выбранному товару"
                    : isPicking
                    ? "Сборка товара перед упаковкой"
                    : isWaitingAdmin
                    ? "Ожидает запуска сборки товара"
                    : employeeSupplySession?.canWork
                    ? "Товары в поставке"
                    : "Старт и контроль сборки"}
                </div>
              </div>
              <div className="modal-actions-inline">
                {employeeSelectedOrder && !employeeSelectedOrder.scanPassed ? (
                  <button
                    className="ghost-button small danger"
                    type="button"
                    onClick={() => {
                      props.setEmployeeIssueError("");
                      props.setEmployeeIssueValue("");
                      props.setEmployeeIssueOpen(true);
                    }}
                  >
                    Ошибка
                  </button>
                ) : null}
                {isPicking && !employeeSelectedOrder && !employeeSelectedItem ? (
                  <button
                    className="ghost-button small danger"
                    type="button"
                    onClick={() => {
                      setEmployeePickIssueError("");
                      setEmployeePickIssueValue("");
                      setEmployeePickIssueItemId(String(employeePickItems.find((item) => Number(item.remainingQty || 0) > 0)?.id || ""));
                      setEmployeePickIssueOpen(true);
                    }}
                  >
                    Ошибка
                  </button>
                ) : null}
                {employeeSelectedItem && !employeeSelectedOrder ? (
                  <button className="ghost-button small" type="button" onClick={() => setEmployeeSelectedItem(null)}>
                    Назад
                  </button>
                ) : null}
                {employeeSelectedOrder ? (
                  <button className="ghost-button small" type="button" onClick={() => setEmployeeSelectedOrder(null)}>
                    К списку
                  </button>
                ) : null}
                <button className="icon-button" type="button" onClick={() => setEmployeeSelectedSupply(null)}>
                  {"\u00D7"}
                </button>
              </div>
            </div>

            <div className="modal-body">
              {employeeFlowNotice ? <div className="alert success">{employeeFlowNotice}</div> : null}
              {employeeFlowWarning ? <div className="alert warn">{employeeFlowWarning}</div> : null}
              {employeeSupplySessionLoading ? (
                <div className="empty">Загрузка состояния поставки...</div>
              ) : employeeSupplySessionError ? (
                <div className="empty error">{employeeSupplySessionError}</div>
              ) : employeeSelectedOrder ? (
                <OrderDetail {...props} employeeSelectedSupply={employeeSelectedSupply} nextOrder={nextOrder} />
              ) : employeeSelectedItem ? (
                employeeOrdersLoading ? (
                  <div className="empty">Загрузка заказов...</div>
                ) : employeeOrdersError ? (
                  <div className="empty error">{employeeOrdersError}</div>
                ) : (
                  <OrdersList
                    orders={employeeOrders}
                    setEmployeeSelectedOrder={setEmployeeSelectedOrder}
                    formatDate={formatDate}
                    timeAgo={timeAgo}
                  />
                )
              ) : isWaitingAdmin ? (
                <div className="employee-start-screen">
                  <div className="employee-start-hero">
                    <div>
                      <div className="section-title">Сборка товара</div>
                      <div className="hint">Поставка распределена. Дождитесь запуска сборки товара админом.</div>
                    </div>
                    <span className="pill">{sessionStatusText(employeeSelectedSupply, session)}</span>
                  </div>
                  <div className="employee-session-grid">
                    <MetricCard label="Назначено заказов" value={assignedOrders} />
                    <MetricCard label="Собрано товаров" value={pickCollectedQty} />
                    <MetricCard label="Собрано заказов" value={collectedOrders} />
                    <MetricCard label="Время упаковки" value={formatDuration(session?.totalSeconds)} />
                  </div>
                </div>
              ) : isPicking ? (
                <div className="employee-start-screen">
                  <div className="employee-start-hero">
                    <div>
                      <div className="section-title">Сборка товара</div>
                      <div className="hint">Сканируйте товар с полок. Система сверяет его по складской БД и уменьшает остаток по вашей сборке.</div>
                    </div>
                    <span className="pill active-pill">Сборка товара в работе</span>
                  </div>
                  <div className="employee-session-grid">
                    <MetricCard label="Назначено заказов" value={assignedOrders} />
                    <MetricCard label="Нужно собрать" value={pickRequiredQty} />
                    <MetricCard label="Собрано" value={pickCollectedQty} />
                    <MetricCard label="Осталось" value={pickRemainingQty} />
                  </div>
                  <div className="employee-session-meta">
                    <DetailRow label="Выдано" value={formatDateTime(session?.assignedAt)} />
                    <DetailRow label="Старт сборки товара" value={formatDateTime(session?.pickingStartedAt)} />
                    <DetailRow label="Время сборки товара" value={formatDuration(session?.pickingTotalSeconds)} />
                  </div>
                  <div className="scan-block scan-block-top">
                    <div className="field">
                      <span>Штрихкод товара</span>
                      <input
                        ref={employeePickScanInputRef}
                        className="input"
                        value={employeePickScanValue}
                        onChange={(e) => setEmployeePickScanValue(e.target.value)}
                        onBlur={handleEmployeePickScanInputBlur}
                        placeholder="Отсканируйте товар с полки"
                        readOnly={employeePickScanBusy}
                        aria-disabled={employeePickScanBusy ? "true" : undefined}
                      />
                    </div>
                    {employeePickScanError ? <div className="alert small">{employeePickScanError}</div> : null}
                    {employeePickFinishError ? <div className="alert small">{employeePickFinishError}</div> : null}
                    <div className="employee-start-actions">
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => {
                          setEmployeePickIssueError("");
                          setEmployeePickIssueValue("");
                          setEmployeePickIssueItemId(String(employeePickItems.find((item) => Number(item.remainingQty || 0) > 0)?.id || ""));
                          setEmployeePickIssueOpen(true);
                        }}
                        disabled={employeePickIssueBusy}
                      >
                        Ошибка
                      </button>
                      <button
                        className="primary-button"
                        type="button"
                        onClick={handleEmployeePickFinish}
                        disabled={!pickReadyToFinish || employeePickFinishBusy}
                      >
                        {employeePickFinishBusy ? "Завершаем..." : "Завершить сборку товара"}
                      </button>
                    </div>
                    <div className="hint small">
                      Если товар не засчитался, нажмите «Ошибка» и отправьте штрихкод админу.
                    </div>
                  </div>
                  {employeePickItemsLoading ? (
                    <div className="empty">Загрузка сборки товара...</div>
                  ) : employeePickItemsError ? (
                    <div className="empty error">{employeePickItemsError}</div>
                  ) : (
                    <PickItemsList
                      items={employeePickItems}
                      formatFbsCells={formatFbsCells}
                      employeePickManualBusyId={employeePickManualBusyId}
                      handleEmployeePickCollectWithoutScan={handleEmployeePickCollectWithoutScan}
                      pickItemsBodyRef={props.employeePickListBodyRef}
                    />
                  )}
                  {employeePickIssueOpen ? (
                    <div className="issue-overlay">
                      <div className="issue-overlay-card">
                        <div className="section-title">Ошибка сборки товара</div>
                        <div className="hint">Выберите товар из списка и отсканируйте проблемный штрихкод. Админ увидит точную строку сборки товара.</div>
                        <div className="field">
                          <span>Товар</span>
                          <select
                            className="input"
                            value={employeePickIssueItemId}
                            onChange={(e) => setEmployeePickIssueItemId(e.target.value)}
                            disabled={employeePickIssueBusy}
                          >
                            <option value="">Выберите товар</option>
                            {employeePickItems.map((item) => (
                              <option key={item.id} value={item.id}>
                                {(item.productName || "Без названия") + (item.article ? ` · ${item.article}` : "")}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="field">
                          <span>Штрихкод товара</span>
                          <input
                            ref={employeePickIssueInputRef}
                            className="input"
                            value={employeePickIssueValue}
                            onChange={(e) => setEmployeePickIssueValue(e.target.value)}
                            placeholder="Отсканируйте штрихкод"
                            disabled={employeePickIssueBusy}
                          />
                        </div>
                        {employeePickIssueError ? <div className="alert small">{employeePickIssueError}</div> : null}
                        <div className="detail-actions">
                          <button
                            className="primary-button small"
                            type="button"
                            onClick={() => {
                              if (!employeePickIssueValue.trim() || !employeePickIssueItemId) return;
                              handleEmployeePickIssueSubmit(employeePickIssueValue);
                            }}
                            disabled={employeePickIssueBusy || !employeePickIssueValue.trim() || !employeePickIssueItemId}
                          >
                            Отправить
                          </button>
                          <button
                            className="ghost-button small"
                            type="button"
                            onClick={() => {
                              setEmployeePickIssueError("");
                              setEmployeePickIssueValue("");
                              setEmployeePickIssueItemId("");
                              setEmployeePickIssueOpen(false);
                            }}
                            disabled={employeePickIssueBusy}
                          >
                            Отмена
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : !employeeSupplySession?.canWork ? (
                <div className="employee-start-screen">
                  <div className="employee-start-hero">
                    <div>
                      <div className="section-title">{startTitle}</div>
                      <div className="hint">{startHint}</div>
                    </div>
                    <span className="pill">{sessionStatusText(employeeSelectedSupply, session)}</span>
                  </div>
                  <div className="employee-session-grid">
                    <MetricCard label="Назначено заказов" value={assignedOrders} />
                    <MetricCard label="Собрано товаров" value={pickCollectedQty} />
                    <MetricCard label="Собрано заказов" value={collectedOrders} />
                    <MetricCard label="Осталось заказов" value={remainingOrders} />
                  </div>
                  <div className="employee-session-meta">
                    <DetailRow label="Выдано" value={formatDateTime(session?.assignedAt)} />
                    <DetailRow label="Старт сборки товара" value={formatDateTime(session?.pickingStartedAt)} />
                    <DetailRow label="Финиш сборки товара" value={formatDateTime(session?.pickingFinishedAt)} />
                    <DetailRow label="Время сборки товара" value={formatDuration(session?.pickingTotalSeconds)} />
                    <DetailRow label="Старт упаковки" value={formatDateTime(session?.startedAt)} />
                    <DetailRow label="Время упаковки" value={formatDuration(session?.totalSeconds)} />
                  </div>
                  {activeSession && activeSession.supplyId !== employeeSelectedSupply.id ? (
                    <div className="alert small">Сначала завершите другую активную поставку: {activeSession.supplyId}</div>
                  ) : null}
                  {employeeStartError ? <div className="alert small">{employeeStartError}</div> : null}
                  {(canStartPicking || canStartPacking || employeeSupplySession?.canStart) ? (
                    <div className="employee-start-actions">
                      <button className="primary-button" type="button" onClick={handleEmployeeStart} disabled={employeeStartBusy}>
                        {employeeStartBusy ? "Запуск..." : startButtonText}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : employeeItemsLoading ? (
                <div className="empty">Загрузка товаров...</div>
              ) : employeeItemsError ? (
                <div className="empty error">{employeeItemsError}</div>
              ) : (
                <>
                  <div className="employee-work-header">
                    <div className="employee-work-meta">
                      <span className="pill active-pill">Упаковка в работе</span>
                      <span className="hint">Старт: {formatDateTime(session?.startedAt)} • Осталось {remainingOrders}</span>
                    </div>
                  </div>
                  <div className="scan-block scan-block-top">
                    <div className="field">
                      <span>Штрихкод товара</span>
                      <input
                        ref={employeeLookupInputRef}
                        className="input"
                        value={employeeLookupValue}
                        onChange={(e) => setEmployeeLookupValue(e.target.value)}
                        placeholder="Отсканируйте товар"
                        disabled={employeeLookupBusy}
                      />
                    </div>
                    <div className="hint small">
                      Скан ищет первый подходящий заказ в этой поставке и сразу засчитывает безошибочную сборку.
                    </div>
                    {employeeLookupError ? <div className="alert small">{employeeLookupError}</div> : null}
                  </div>
                  <ItemsList items={employeeItems} setEmployeeSelectedItem={setEmployeeSelectedItem} />
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
