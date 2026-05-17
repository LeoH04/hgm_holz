const ordersList = document.querySelector("#orders-list");
const refreshButton = document.querySelector("#refresh-button");
const adminFeedback = document.querySelector("#admin-feedback");

const statusLabels = {
  neu: "Neu",
  kontaktiert: "Kontaktiert",
  erledigt: "Erledigt"
};

refreshButton.addEventListener("click", loadOrders);
loadOrders();

async function loadOrders() {
  ordersList.innerHTML = '<p class="empty-state">Bestellungen werden geladen ...</p>';

  try {
    const response = await fetch("/api/admin/orders");
    const result = await response.json();

    if (response.status === 401) {
      window.location.href = "/admin/login";
      return;
    }

    if (!response.ok) {
      throw new Error(result.error || "Bestellungen konnten nicht geladen werden.");
    }

    renderOrders(result.orders || []);
  } catch (error) {
    ordersList.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
  }
}

function renderOrders(orders) {
  updateStats(orders);

  if (orders.length === 0) {
    ordersList.innerHTML = '<p class="empty-state">Noch keine Bestellungen vorhanden.</p>';
    return;
  }

  const groups = [
    {
      status: "neu",
      title: "Neue Bestellungen",
      description: "Anfragen, die noch nicht bearbeitet wurden."
    },
    {
      status: "kontaktiert",
      title: "In Bearbeitung",
      description: "Kunden, bei denen bereits Rückmeldung oder Abstimmung läuft."
    },
    {
      status: "erledigt",
      title: "Erledigte Bestellungen",
      description: "Abgeschlossene Anfragen zur Ablage."
    }
  ];

  ordersList.innerHTML = groups.map((group) => renderGroup(group, orders)).join("");

  for (const select of ordersList.querySelectorAll("[data-status-select]")) {
    select.addEventListener("change", () => updateStatus(select.dataset.orderId, select.value));
  }

  for (const button of ordersList.querySelectorAll("[data-delete-order]")) {
    button.addEventListener("click", () => openDeleteConfirm(button.dataset.orderId));
  }

  for (const button of ordersList.querySelectorAll("[data-cancel-delete]")) {
    button.addEventListener("click", () => closeDeleteConfirm(button.dataset.orderId));
  }

  for (const button of ordersList.querySelectorAll("[data-confirm-delete]")) {
    button.addEventListener("click", () => deleteOrder(button.dataset.orderId, button.dataset.orderName));
  }
}

function renderGroup(group, orders) {
  const groupOrders = orders.filter((order) => order.status === group.status);

  return `
    <details class="order-group order-group--${group.status}">
      <summary class="group-head">
        <div>
          <h3 id="group-${group.status}">${group.title}</h3>
          <p>${group.description}</p>
        </div>
        <span>${groupOrders.length}</span>
      </summary>
      <div class="orders-list">
        ${
          groupOrders.length
            ? groupOrders.map(renderOrder).join("")
            : '<p class="empty-state">Keine Bestellungen in diesem Bereich.</p>'
        }
      </div>
    </details>
  `;
}

function renderOrder(order) {
  const createdAt = new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(order.created_at));

  return `
    <article class="order-card order-card--${escapeHtml(order.status)}">
      <div>
        <h4>${escapeHtml(order.name)}</h4>
        <p class="meta">#${order.id} · ${createdAt}</p>
        <div class="details">
          <p><strong>Telefon:</strong> ${escapeHtml(order.telefon)}</p>
          <p><strong>E-Mail:</strong> ${escapeHtml(order.email || "-")}</p>
          <p><strong>Adresse:</strong> ${escapeHtml(order.adresse || "-")}</p>
          <p><strong>Menge:</strong> ${escapeHtml(order.menge)}</p>
          <p><strong>Übergabe:</strong> ${escapeHtml(order.uebergabe)}</p>
        </div>
        ${order.nachricht ? `<p class="message">${escapeHtml(order.nachricht)}</p>` : ""}
      </div>
      <div class="order-actions">
        <label class="status-label" for="status-${order.id}">Status</label>
        <select id="status-${order.id}" data-status-select data-order-id="${order.id}">
          ${Object.entries(statusLabels).map(([value, label]) => `
            <option value="${value}" ${order.status === value ? "selected" : ""}>${label}</option>
          `).join("")}
        </select>
        <button class="delete-button" type="button" data-delete-order data-order-id="${order.id}" aria-expanded="false" aria-controls="delete-confirm-${order.id}" aria-label="Bestellung #${order.id} löschen">
          Löschen
        </button>
        <div class="delete-confirm" id="delete-confirm-${order.id}" data-delete-confirm data-order-id="${order.id}" hidden>
          <p>Bestellung #${order.id} von ${escapeHtml(order.name)} endgültig löschen?</p>
          <div class="delete-confirm__actions">
            <button class="delete-confirm__primary" type="button" data-confirm-delete data-order-id="${order.id}" data-order-name="${escapeHtml(order.name)}">
              Endgültig löschen
            </button>
            <button class="delete-confirm__secondary" type="button" data-cancel-delete data-order-id="${order.id}">
              Abbrechen
            </button>
          </div>
        </div>
      </div>
    </article>
  `;
}

async function updateStatus(orderId, status) {
  const response = await fetch(`/api/admin/orders/${orderId}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status })
  });

  if (response.status === 401) {
    window.location.href = "/admin/login";
    return;
  }

  if (!response.ok) {
    await loadOrders();
    return;
  }

  await loadOrders();
}

function openDeleteConfirm(orderId) {
  for (const panel of ordersList.querySelectorAll("[data-delete-confirm]")) {
    const isActive = panel.dataset.orderId === orderId;
    panel.hidden = !isActive;
  }

  for (const button of ordersList.querySelectorAll("[data-delete-order]")) {
    button.setAttribute("aria-expanded", String(button.dataset.orderId === orderId));
  }

  ordersList.querySelector(`[data-confirm-delete][data-order-id="${orderId}"]`)?.focus();
}

function closeDeleteConfirm(orderId) {
  const panel = ordersList.querySelector(`[data-delete-confirm][data-order-id="${orderId}"]`);
  const trigger = ordersList.querySelector(`[data-delete-order][data-order-id="${orderId}"]`);

  if (panel) panel.hidden = true;
  if (trigger) {
    trigger.setAttribute("aria-expanded", "false");
    trigger.focus();
  }
}

async function deleteOrder(orderId, orderName) {
  setFeedback("");

  const response = await fetch(`/api/admin/orders/${orderId}`, {
    method: "DELETE"
  });

  if (response.status === 401) {
    window.location.href = "/admin/login";
    return;
  }

  if (!response.ok) {
    let message = "Bestellung konnte nicht gelöscht werden.";

    try {
      const result = await response.json();
      message = result.error || message;
    } catch {
      // Der sichtbare Fallback reicht aus, falls keine JSON-Antwort kommt.
    }

    setFeedback(message, "error");
    await loadOrders();
    return;
  }

  await loadOrders();
  setFeedback(`Bestellung #${orderId} von ${orderName} wurde gelöscht.`, "success");
}

function updateStats(orders) {
  document.querySelector("#stat-total").textContent = orders.length;
  document.querySelector("#stat-new").textContent = orders.filter((order) => order.status === "neu").length;
  document.querySelector("#stat-contacted").textContent = orders.filter((order) => order.status === "kontaktiert").length;
  document.querySelector("#stat-done").textContent = orders.filter((order) => order.status === "erledigt").length;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setFeedback(message, type = "success") {
  adminFeedback.textContent = message;
  adminFeedback.hidden = !message;
  adminFeedback.dataset.type = type;
}
