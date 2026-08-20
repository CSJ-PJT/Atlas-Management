export function bindNodeInteraction(element, activate) {
  const onClick = () => activate();
  const onKeyDown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    activate();
  };

  element.addEventListener("click", onClick);
  element.addEventListener("keydown", onKeyDown);

  return () => {
    element.removeEventListener("click", onClick);
    element.removeEventListener("keydown", onKeyDown);
  };
}
