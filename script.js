const orderForm = document.querySelector(".order-form");

if (orderForm) {
  const statusMessage = orderForm.querySelector(".form-status");
  const submitButton = orderForm.querySelector('button[type="submit"]');

  orderForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!orderForm.reportValidity()) return;

    const formData = new FormData(orderForm);
    const payload = Object.fromEntries(formData.entries());
    payload.datenschutz = formData.get("datenschutz") === "on";

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
      setFormState("Danke, die Anfrage wurde gesendet.", "success", false);
    } catch (error) {
      setFormState(error.message, "error", false);
    }
  });

  function setFormState(message, tone, isLoading) {
    statusMessage.textContent = message;
    statusMessage.dataset.tone = tone;
    submitButton.disabled = isLoading;
  }
}
