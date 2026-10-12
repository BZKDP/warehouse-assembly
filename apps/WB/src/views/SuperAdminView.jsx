import UserDirectoryPicker from "../components/UserDirectoryPicker.jsx";

function roleLabel(role) {
  if (role === "admin") return "Админ";
  if (role === "employee") return "Упаковщик";
  return "Супер админ";
}

function userName(user) {
  return user?.fullName || [user?.surname, user?.name].filter(Boolean).join(" ").trim() || user?.login || "—";
}

export default function SuperAdminView({
  currentUser,
  userTab,
  setUserTab,
  users,
  usersLoading,
  usersError,
  userDirectory,
  userDirectoryLoading,
  userDirectoryError,
  userActionError,
  userActionBusy,
  createExternalUserId,
  setCreateExternalUserId,
  handleCreateUser,
  handleLogout,
  openEditUser,
  handleDeleteUser,
  editUser,
  setEditUser,
  editRole,
  setEditRole,
  handleSaveUser,
  formatDate,
}) {
  const admins = users.filter((user) => user.role === "admin");
  const employees = users.filter((user) => user.role === "employee");
  const visibleUsers = userTab === "admins" ? admins : employees;
  const availableDirectoryUsers = userDirectory.filter((entry) => !entry.alreadyAdded);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="dot" />
          <div>
            <div className="title">WB Склад</div>
            <div className="subtitle">Супер админ</div>
          </div>
        </div>
        <div className="topbar-right">
          <div className="user-chip">
            <div className="user-name">{userName(currentUser)}</div>
            <div className="user-role">Супер админ</div>
          </div>
          <button className="ghost-button small" type="button" onClick={handleLogout}>
            Выйти
          </button>
        </div>
      </header>

      <div className="tabs">
        <button
          className={`tab ${userTab === "admins" ? "active" : ""}`}
          onClick={() => setUserTab("admins")}
          type="button"
        >
          Админы
          <span className="badge">{admins.length}</span>
        </button>
        <button
          className={`tab ${userTab === "employees" ? "active" : ""}`}
          onClick={() => setUserTab("employees")}
          type="button"
        >
          Сотрудники
          <span className="badge">{employees.length}</span>
        </button>
      </div>

      <section className="card">
        <div className="section-header">
          <div className="section-title">Пользователи сайта</div>
          <div className="hint">Логин и пароль берутся из общей базы сотрудников, здесь задаётся только доступ к WB.</div>
        </div>

        <div className="form-grid">
          <label className="field">
            <span>Сотрудник</span>
            <UserDirectoryPicker
              value={createExternalUserId}
              onChange={setCreateExternalUserId}
              options={availableDirectoryUsers}
              loading={userDirectoryLoading}
              disabled={userDirectoryLoading || userActionBusy}
            />
          </label>
          <label className="field">
            <span>Роль</span>
            <input className="input" value={userTab === "admins" ? "Админ" : "Упаковщик"} readOnly />
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
              <div className="empty">Загрузка...</div>
            ) : visibleUsers.length === 0 ? (
              <div className="empty">Пользователи для этой вкладки пока не добавлены</div>
            ) : (
              visibleUsers.map((user) => (
                <div className="row" key={user.id}>
                  <div className="col">
                    <div className="primary">{userName(user)}</div>
                  </div>
                  <div className="col mono">{user.login || "—"}</div>
                  <div className="col mono">{roleLabel(user.role)}</div>
                  <div className="col">{formatDate(user.createdAt)}</div>
                  <div className="col right actions">
                    <button className="ghost-button small" type="button" onClick={() => openEditUser(user)}>
                      Роль
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
      </section>

      {editUser && (
        <div className="modal-backdrop" onClick={() => setEditUser(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Роль пользователя</div>
                <div className="modal-subtitle">{userName(editUser)}</div>
              </div>
              <button className="icon-button" onClick={() => setEditUser(null)} type="button">
                ×
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
                    <option value="admin">Админ</option>
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
    </div>
  );
}
