export default function Loading() {
  return (
    <div className="container mx-auto animate-pulse px-4 py-12">
      <div className="mx-auto max-w-3xl text-center">
        <div className="mx-auto h-8 w-48 rounded-full bg-foreground/5" />
        <div className="mx-auto mt-6 h-10 w-3/4 rounded-lg bg-foreground/5 md:h-16" />
        <div className="mx-auto mt-4 h-5 w-2/3 rounded bg-foreground/5" />
      </div>
      <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card h-48" />
        ))}
      </div>
    </div>
  );
}