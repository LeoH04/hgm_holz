const ordersList = document.querySelector("#orders-list");
const refreshButton = document.querySelector("#refresh-button");

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
