import { Link } from "react-router";
import { FullPageMessage } from "../components/ui";

export function NotFoundPage() {
  return (
    <FullPageMessage>
      <span>
        Page not found.{" "}
        <Link className="text-accent hover:underline" to="/">
          Go home
        </Link>
      </span>
    </FullPageMessage>
  );
}
