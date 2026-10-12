function sessionStatusText(assembly, session) {
  if (assembly?.currentStage === "picking" || session?.pickingStartedAt) return "Сборка товара";
  if (assembly?.currentStage === "waiting_admin") return "Ждёт запуска админом";
  if (assembly?.currentStage === "picking_ready") return "Готова к сборке товара";
  if (assembly?.canWork || (session?.startedAt && !session?.finishedAt)) return "Упаковка заказов";
  if (assembly?.canStartPacking) return "Готова к упаковке";
  if (assembly?.canStart) return "Готова к старту";
  if (assembly?.hasAnotherActiveSession) return "Есть другая активная сборка";
  if (session?.finishedAt) return "Сессия завершена";
  return "Назначена";
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

function PickItemsList(props) {
  const {
    items,
    formatFbsCells,
    employeePickManualBusyId,
    handleEmployeePickCollectWithoutScan,
    pickItemsBodyRef,
  } = props;

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
                <div className="pick-item-cell-value">{formatFbsCells(item.msCells)}</div>
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

export default function EmployeeView(props) {
  const {
    currentUser,
    handleLogout,
    employeeAssembliesError,
    employeeAssembliesLoading,
    employeeAssemblies,
    employeeSelectedAssembly,
    setEmployeeSelectedAssembly,
    openEmployeeAssembly,
    employeeSelectedOrder,
    setEmployeeSelectedOrder,
    employeeAssemblySession,
    employeeAssemblySessionLoading,
    employeeAssemblySessionError,
    employeeStartBusy,
    employeeStartError,
    employeeFlowNotice,
    employeeFlowWarning,
    employeePickItems,
    employeePickItemsLoading,
    employeePickItemsError,
    employeePickListBodyRef,
    employeePickScanInputRef,
    handleEmployeePickScanInputBlur,
    employeePickScanValue,
    setEmployeePickScanValue,
    employeePickScanBusy,
    employeePickScanError,
    employeePickFinishBusy,
    employeePickFinishError,
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
    employeePickManualBusyId,
    handleEmployeePickCollectWithoutScan,
    handleEmployeePickIssueSubmit,
    handleEmployeePickFinish,
    employeeLookupInputRef,
    employeeLookupValue,
    setEmployeeLookupValue,
    employeeLookupBusy,
    employeeLookupError,
    employeeOrders,
    employeeOrdersLoading,
    employeeOrdersError,
    scanInputRef,
    scanValue,
    setScanValue,
    scanBusy,
    scanError,
    labelScanInputRef,
    labelScanValue,
    setLabelScanValue,
    labelScanBusy,
    labelScanError,
    employeeIssueOpen,
    setEmployeeIssueOpen,
    employeeIssueInputRef,
    employeeIssueValue,
    setEmployeeIssueValue,
    employeeIssueBusy,
    employeeIssueError,
    employeeIssueLineNos,
    setEmployeeIssueLineNos,
    handleEmployeeIssueSubmit,
    handleEmployeeStart,
    handleEmployeeLookupScan,
    handleProductScan,
    handleLabelScan,
    formatDate,
    formatDuration,
    formatFbsCells,
    orderItemsSummary,
  } = props;

  const session = employeeAssemblySession?.session || employeeSelectedAssembly?.session || null;
  const workflow = employeeAssemblySession?.workflow || {};
  const assemblyMeta = employeeAssemblySession?.assembly || employeeSelectedAssembly || null;
  const activeSession = employeeAssemblySession?.activeSession || null;
  const assignedOrders = Number(assemblyMeta?.total || session?.assignedOrderCount || 0);
  const collectedOrders = Number(assemblyMeta?.collected || session?.collectedOrderCount || 0);
  const remainingOrders = Number(assemblyMeta?.remaining || Math.max(0, assignedOrders - collectedOrders));
  const currentStage = workflow?.currentStage || (employeeAssemblySession?.canWork ? "packing" : "packing_ready");
  const isWaitingAdmin = currentStage === "waiting_admin";
  const isPicking = currentStage === "picking";
  const canStartPicking = Boolean(workflow?.canStartPicking);
  const canStartPacking = Boolean(workflow?.canStartPacking || (!workflow?.productPickingRequired && employeeAssemblySession?.canStart));
  const pickRequiredQty = Number(session?.pickingRequiredQty || 0);
  const pickCollectedQty = Number(session?.pickingCollectedQty || 0);
  const pickRemainingQty = Math.max(0, Number(session?.pickingRemainingQty || pickRequiredQty - pickCollectedQty));
  const pickReadyToFinish = pickRequiredQty > 0 && pickRemainingQty === 0;
  const employeeOrderView =
    employeeOrders.find((order) => order.postingNumber === employeeSelectedOrder?.postingNumber) || employeeSelectedOrder;
  const orderIndex = employeeOrderView
    ? employeeOrders.findIndex((order) => order.postingNumber === employeeOrderView.postingNumber)
    : -1;
  const nextOrder = orderIndex >= 0 ? employeeOrders[orderIndex + 1] : null;
  const firstPendingPickItem = employeePickItems.find((item) => Number(item.remainingQty || 0) > 0) || null;
  const startTitle = workflow?.productPickingRequired && !session?.pickingFinishedAt ? "Сборка товара" : "Сессия сборки";
  const startHint = workflow?.productPickingRequired && !session?.pickingFinishedAt
    ? "Нажмите «Старт», чтобы открыть сборку товара перед упаковкой заказов."
    : workflow?.productPickingRequired && session?.pickingFinishedAt
      ? "Товары уже собраны. Нажмите «Старт», чтобы перейти к упаковке заказов."
      : "Нажмите «Старт», чтобы открыть заказы и начать работу со сборкой.";
  const startButtonText = canStartPicking ? "Старт сборки товара" : "Старт упаковки";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="dot" />
          <div>
            <div className="title">Ozon Склад</div>
            <div className="subtitle">Кабинет сотрудника</div>
          </div>
        </div>
        <div className="topbar-right">
          <div className="user-chip">
            <div className="user-name">{currentUser.surname} {currentUser.name}</div>
            <div className="user-role">Сотрудник</div>
          </div>
          <button className="ghost-button small" type="button" onClick={handleLogout}>Выйти</button>
        </div>
      </header>

      {employeeAssembliesError ? <div className="alert">{employeeAssembliesError}</div> : null}
      <section className="card">
        <div className="section-header">
          <div className="section-title">Мои сборки</div>
          <div className="hint">Сборка становится рабочей только после запуска нужного этапа.</div>
        </div>
        <div className="list supplies">
          <div className="list-header">
            <div className="col">Сборка</div>
            <div className="col">Статус</div>
            <div className="col right">Осталось</div>
          </div>
          <div className="list-body">
            {employeeAssembliesLoading ? (
              <div className="empty">Загрузка...</div>
            ) : employeeAssemblies.length === 0 ? (
              <div className="empty">Нет активных сборок</div>
            ) : (
              employeeAssemblies.map((assembly) => (
                <button className="row row-button" key={assembly.id} type="button" onClick={() => openEmployeeAssembly(assembly)}>
                  <div className="col">
                    <div className="primary">{assembly.name || `Сборка ${assembly.id}`}</div>
                    <div className="muted">{assembly.storeName ? `Магазин: ${assembly.storeName} · ` : ""}Назначено: {assembly.total || 0}</div>
                  </div>
                  <div className="col">
                    <span className={`pill ${assembly.canWork || assembly.currentStage === "picking" ? "active-pill" : ""}`}>
                      {sessionStatusText(assembly, assembly.session)}
                    </span>
                  </div>
                  <div className="col right"><span className="count">{assembly.remaining}</span></div>
                </button>
              ))
            )}
          </div>
        </div>
      </section>

      {employeeSelectedAssembly ? (
        <div className="modal-backdrop" onClick={() => setEmployeeSelectedAssembly(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">
                  {employeeSelectedAssembly.name}
                  {employeeSelectedAssembly.storeName ? ` · ${employeeSelectedAssembly.storeName}` : ""}
                </div>
                <div className="modal-subtitle">
                  {employeeSelectedOrder
                    ? employeeSelectedOrder.postingNumber
                    : isPicking
                      ? "Сборка товара перед упаковкой"
                      : isWaitingAdmin
                        ? "Ожидает запуска сборки товара"
                        : employeeAssemblySession?.canWork
                          ? "Упаковка заказов"
                          : "Старт и контроль сборки"}
                </div>
              </div>
              <div className="modal-actions-inline">
                {employeeSelectedOrder && !employeeOrderView?.scanDone ? (
                  <button className="ghost-button small danger" type="button" onClick={() => setEmployeeIssueOpen(true)}>
                    Ошибка
                  </button>
                ) : null}
                {isPicking && !employeeSelectedOrder ? (
                  <button
                    className="ghost-button small danger"
                    type="button"
                    onClick={() => {
                      setEmployeePickIssueError("");
                      setEmployeePickIssueValue("");
                      setEmployeePickIssueItemId(String(firstPendingPickItem?.id || ""));
                      setEmployeePickIssueOpen(true);
                    }}
                  >
                    Ошибка
                  </button>
                ) : null}
                {employeeSelectedOrder ? (
                  <button className="ghost-button small" type="button" onClick={() => setEmployeeSelectedOrder(null)}>
                    К списку
                  </button>
                ) : null}
                <button className="icon-button" type="button" onClick={() => setEmployeeSelectedAssembly(null)}>
                  ×
                </button>
              </div>
            </div>

            <div className="modal-body">
              {employeeFlowNotice ? <div className="alert success">{employeeFlowNotice}</div> : null}
              {employeeFlowWarning ? <div className="alert warn">{employeeFlowWarning}</div> : null}

              {employeeAssemblySessionLoading ? (
                <div className="empty">Загрузка состояния сборки...</div>
              ) : employeeAssemblySessionError ? (
                <div className="empty error">{employeeAssemblySessionError}</div>
              ) : employeeSelectedOrder ? (
                <>
                <div className="order-detail">
                  <DetailRow label="Заказ" value={employeeOrderView?.postingNumber || "—"} mono />
                  <DetailRow label="Создан" value={formatDate(employeeOrderView?.createdAt)} />
                  <DetailRow
                    label="Прогресс"
                    value={`${employeeOrderView?.scannedItems || 0}/${employeeOrderView?.totalItems || 0}`}
                  />

                  <div className="list items compact employee-items-list">
                    <div className="list-header">
                      <div className="col">Артикул</div>
                      <div className="col">Название</div>
                      <div className="col right">Скан</div>
                    </div>
                    <div className="list-body">
                      {(employeeOrderView?.items || []).map((item) => (
                        <div className={`row ${item.scannedQty >= item.quantity ? "assigned" : ""}`} key={`${item.lineNo}-${item.article}`}>
                          <div className="col">
                            <div className="primary mono">{item.article || "-"}</div>
                            {employeeIssueOpen ? (
                              <label className="employee-issue-checkbox">
                                <input
                                  type="checkbox"
                                  checked={employeeIssueLineNos.includes(item.lineNo)}
                                  onChange={(event) =>
                                    setEmployeeIssueLineNos((prev) =>
                                      event.target.checked
                                        ? [...new Set([...prev, item.lineNo])]
                                        : prev.filter((value) => value !== item.lineNo)
                                    )
                                  }
                                />
                                <span>Ошибка по этому товару</span>
                              </label>
                            ) : null}
                          </div>
                          <div className="col">
                            <div className="product-with-photo">
                              <ProductImage src={item.imageUrl} alt={item.name || "Фото товара"} />
                              <div>{item.name || "-"}</div>
                            </div>
                          </div>
                          <div className="col right">
                            <span className="count">{item.scannedQty}/{item.quantity}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {!employeeOrderView?.scanDone ? (
                    <div className="scan-block">
                      <div className="field">
                        <span>Безошибочная сборка · штрихкод товара</span>
                        <input
                          ref={scanInputRef}
                          className="input"
                          value={scanValue}
                          onChange={(event) => setScanValue(event.target.value)}
                          onKeyDown={(event) => event.key === "Enter" && handleProductScan()}
                          disabled={scanBusy}
                        />
                      </div>
                      {scanError ? <div className="alert small">{scanError}</div> : null}
                    </div>
                  ) : (
                    <>
                      <div className="scan-status success">Все товары отсканированы</div>
                      <div className="detail-actions">
                        <button
                          className="primary-button"
                          type="button"
                          onClick={() => employeeOrderView?.labelUrl && window.open(employeeOrderView.labelUrl, "_blank")}
                          disabled={!employeeOrderView?.labelUrl}
                        >
                          {employeeOrderView?.labelUrl ? "Открыть этикетку" : "Этикетка ещё не загружена"}
                        </button>
                        {nextOrder ? (
                          <button className="ghost-button" type="button" onClick={() => setEmployeeSelectedOrder(nextOrder)}>
                            Далее
                          </button>
                        ) : null}
                      </div>
                      {!employeeOrderView?.labelScanPassedAt ? (
                        <div className="scan-block">
                          <div className="field">
                            <span>Скан этикетки</span>
                            <input
                              ref={labelScanInputRef}
                              className="input"
                              value={labelScanValue}
                              onChange={(event) => setLabelScanValue(event.target.value)}
                              onKeyDown={(event) => event.key === "Enter" && handleLabelScan()}
                              disabled={labelScanBusy}
                            />
                          </div>
                          {labelScanError ? <div className="alert small">{labelScanError}</div> : null}
                        </div>
                      ) : (
                        <div className="scan-status success">Этикетка подтверждена</div>
                      )}
                    </>
                  )}
                </div>
                  {employeeIssueOpen ? (
                    <div className="issue-overlay">
                      <div className="issue-overlay-card">
                        <div className="section-title">Ошибка товарного скана</div>
                        <div className="hint">Отметьте проблемные товары и отсканируйте фактический штрихкод. Админ увидит строки и ваш скан.</div>
                        <div className="field">
                          <span>Штрихкод товара</span>
                          <input
                            ref={employeeIssueInputRef}
                            className="input"
                            value={employeeIssueValue}
                            onChange={(event) => setEmployeeIssueValue(event.target.value)}
                            placeholder="Отсканируйте штрихкод"
                            disabled={employeeIssueBusy}
                          />
                        </div>
                        {employeeIssueError ? <div className="alert small">{employeeIssueError}</div> : null}
                        <div className="detail-actions">
                          <button
                            className="primary-button small"
                            type="button"
                            onClick={() => handleEmployeeIssueSubmit()}
                            disabled={employeeIssueBusy || !employeeIssueValue.trim()}
                          >
                            Отправить
                          </button>
                          <button className="ghost-button small" type="button" onClick={() => setEmployeeIssueOpen(false)} disabled={employeeIssueBusy}>
                            Отмена
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : isWaitingAdmin ? (
                <div className="employee-start-screen">
                  <div className="employee-start-hero">
                    <div>
                      <div className="section-title">Сборка товара</div>
                      <div className="hint">Сборка распределена. Дождитесь запуска этапа админом.</div>
                    </div>
                    <span className="pill">{sessionStatusText(employeeSelectedAssembly, session)}</span>
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
                      <div className="hint">Сканируйте товар с полок. Система сверяет его по складской БД и засчитывает в вашу сборку.</div>
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
                    <DetailRow label="Выдано" value={formatDate(session?.assignedAt)} />
                    <DetailRow label="Старт сборки товара" value={formatDate(session?.pickingStartedAt)} />
                    <DetailRow label="Время сборки товара" value={formatDuration(session?.pickingTotalSeconds)} />
                  </div>
                  <div className="scan-block scan-block-top">
                    <div className="field">
                      <span>Штрихкод товара</span>
                      <input
                        ref={employeePickScanInputRef}
                        className="input"
                        value={employeePickScanValue}
                        onChange={(event) => setEmployeePickScanValue(event.target.value)}
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
                          setEmployeePickIssueItemId(String(firstPendingPickItem?.id || ""));
                          setEmployeePickIssueOpen(true);
                        }}
                        disabled={employeePickIssueBusy}
                      >
                        Ошибка
                      </button>
                      <button className="primary-button" type="button" onClick={handleEmployeePickFinish} disabled={!pickReadyToFinish || employeePickFinishBusy}>
                        {employeePickFinishBusy ? "Завершаем..." : "Завершить сборку товара"}
                      </button>
                    </div>
                    <div className="hint small">Если товар не засчитался, нажмите «Ошибка» и отправьте штрихкод админу.</div>
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
                      pickItemsBodyRef={employeePickListBodyRef}
                    />
                  )}
                  {employeePickIssueOpen ? (
                    <div className="issue-overlay">
                      <div className="issue-overlay-card">
                        <div className="section-title">Ошибка сборки товара</div>
                        <div className="hint">Выберите товар из списка и отсканируйте проблемный штрихкод. Админ увидит точную строку сборки.</div>
                        <div className="field">
                          <span>Товар</span>
                          <select className="input" value={employeePickIssueItemId} onChange={(event) => setEmployeePickIssueItemId(event.target.value)} disabled={employeePickIssueBusy}>
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
                            onChange={(event) => setEmployeePickIssueValue(event.target.value)}
                            placeholder="Отсканируйте штрихкод"
                            disabled={employeePickIssueBusy}
                          />
                        </div>
                        {employeePickIssueError ? <div className="alert small">{employeePickIssueError}</div> : null}
                        <div className="detail-actions">
                          <button
                            className="primary-button small"
                            type="button"
                            onClick={() => handleEmployeePickIssueSubmit()}
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
              ) : !employeeAssemblySession?.canWork ? (
                <div className="employee-start-screen">
                  <div className="employee-start-hero">
                    <div>
                      <div className="section-title">{startTitle}</div>
                      <div className="hint">{startHint}</div>
                    </div>
                    <span className="pill">{sessionStatusText(employeeSelectedAssembly, session)}</span>
                  </div>
                  <div className="employee-session-grid">
                    <MetricCard label="Назначено заказов" value={assignedOrders} />
                    <MetricCard label="Собрано товаров" value={pickCollectedQty} />
                    <MetricCard label="Собрано заказов" value={collectedOrders} />
                    <MetricCard label="Осталось заказов" value={remainingOrders} />
                  </div>
                  <div className="employee-session-meta">
                    <DetailRow label="Выдано" value={formatDate(session?.assignedAt)} />
                    <DetailRow label="Старт сборки товара" value={formatDate(session?.pickingStartedAt)} />
                    <DetailRow label="Финиш сборки товара" value={formatDate(session?.pickingFinishedAt)} />
                    <DetailRow label="Время сборки товара" value={formatDuration(session?.pickingTotalSeconds)} />
                    <DetailRow label="Старт упаковки" value={formatDate(session?.startedAt)} />
                    <DetailRow label="Время упаковки" value={formatDuration(session?.totalSeconds)} />
                  </div>
                  {activeSession && activeSession.assemblyId !== employeeSelectedAssembly.id ? (
                    <div className="alert small">Сначала завершите другую активную сборку: {activeSession.assemblyId}</div>
                  ) : null}
                  {employeeStartError ? <div className="alert small">{employeeStartError}</div> : null}
                  {(canStartPicking || canStartPacking || employeeAssemblySession?.canStart) ? (
                    <div className="employee-start-actions">
                      <button className="primary-button" type="button" onClick={handleEmployeeStart} disabled={employeeStartBusy}>
                        {employeeStartBusy ? "Запуск..." : startButtonText}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <>
                  <div className="employee-work-header">
                    <div className="employee-work-meta">
                      <span className="pill active-pill">Упаковка в работе</span>
                      <span className="hint">Старт: {formatDate(session?.startedAt)} • Осталось {remainingOrders}</span>
                    </div>
                  </div>
                  <div className="scan-block scan-block-top">
                    <div className="field">
                      <span>Штрихкод товара</span>
                      <input
                        ref={employeeLookupInputRef}
                        className="input"
                        value={employeeLookupValue}
                        onChange={(event) => setEmployeeLookupValue(event.target.value)}
                        onKeyDown={(event) => event.key === "Enter" && handleEmployeeLookupScan()}
                        placeholder="Отсканируйте товар"
                        disabled={employeeLookupBusy}
                      />
                    </div>
                    <div className="hint small">Скан ищет первый подходящий заказ в этой сборке и сразу продвигает по товарному скану.</div>
                    {employeeLookupError ? <div className="alert small">{employeeLookupError}</div> : null}
                  </div>
                  <div className="list orders compact employee-orders-list">
                    <div className="list-header">
                      <div className="col">Заказ</div>
                      <div className="col">Создан</div>
                      <div className="col right">Собрано</div>
                    </div>
                    <div className="list-body">
                      {employeeOrdersLoading ? (
                        <div className="empty">Загрузка...</div>
                      ) : employeeOrdersError ? (
                        <div className="empty error">{employeeOrdersError}</div>
                      ) : employeeOrders.length === 0 ? (
                        <div className="empty">Нет заказов</div>
                      ) : (
                        employeeOrders.map((order) => (
                          <button className="row row-button" key={order.postingNumber} onClick={() => setEmployeeSelectedOrder(order)} type="button">
                            <div className="col">
                              <div className="product-with-photo">
                                <ProductImage
                                  src={order.items?.find((item) => item.imageUrl)?.imageUrl}
                                  alt={order.items?.[0]?.name || `Заказ ${order.postingNumber}`}
                                />
                                <div>
                                  <div className="primary mono">{order.postingNumber}</div>
                                  <div className="muted employee-order-items-preview">{orderItemsSummary(order)}</div>
                                </div>
                              </div>
                            </div>
                            <div className="col">{formatDate(order.createdAt)}</div>
                            <div className="col right"><span className="count">{order.scannedItems}/{order.totalItems}</span></div>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
