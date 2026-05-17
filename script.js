const orderForm = document.querySelector(".order-form");

if (orderForm) {
  const statusMessage = orderForm.querySelector(".form-status");
  const submitButton = orderForm.querySelector('button[type="submit"]');
  const orderConfirmation = document.querySelector(".order-confirmation");
  const confirmationMessage = orderConfirmation?.querySelector("[data-confirmation-message]");
  const newOrderButton = document.querySelector("[data-new-order]");
  const firstField = orderForm.querySelector("input, select, textarea");

  orderForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!orderForm.reportValidity()) return;

    const formData = new FormData(orderForm);
    const payload = Object.fromEntries(formData.entries());
    payload.datenschutz = formData.get("datenschutz") === "on";
    const confirmationEmail = String(payload.email || "").trim();

    setFormState("Anfrage wird gesendet ...", "info", true);

    try {
      const response = await fetch(orderForm.action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Die Anfrage konnte nicht gesendet werden.");
      }

      orderForm.reset();
      showConfirmation(confirmationEmail);
    } catch (error) {
      setFormState(error.message, "error", false);
    }
  });

  newOrderButton?.addEventListener("click", () => {
    orderForm.reset();
    setFormState("", "", false);
    if (orderConfirmation) orderConfirmation.hidden = true;
    orderForm.hidden = false;
    firstField?.focus();
  });

  function setFormState(message, tone, isLoading) {
    statusMessage.textContent = message;
    statusMessage.dataset.tone = tone;
    submitButton.disabled = isLoading;
  }

  function showConfirmation(email) {
    setFormState("", "", false);
    setConfirmationMessage(email);
    orderForm.hidden = true;
    if (orderConfirmation) {
      orderConfirmation.hidden = false;
      newOrderButton?.focus();
    }
  }

  function setConfirmationMessage(email) {
    if (!confirmationMessage) return;

    confirmationMessage.textContent = `Deine Angaben sind angekommen. Wir haben dir eine Eingangsbestätigung per E-Mail an ${email} geschickt. Eine verbindliche Bestellung entsteht erst nach unserer Rückmeldung und Bestätigung.`;
  }
}
