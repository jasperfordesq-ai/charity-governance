export default function AuthLoading() {
  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <div className="py-5 px-4 text-center">
        <span className="text-2xl font-bold text-teal-primary">CharityPilot</span>
      </div>
      <div className="flex-1 flex items-start justify-center px-4 pt-4 pb-16">
        <div className="w-full max-w-md bg-white border border-gray-200 shadow-lg rounded-xl p-8 sm:p-10 animate-pulse">
          <div className="h-6 bg-gray-200 rounded w-1/2 mx-auto mb-3" />
          <div className="h-4 bg-gray-200 rounded w-2/3 mx-auto mb-8" />
          <div className="space-y-5">
            <div className="h-12 bg-gray-200 rounded-xl" />
            <div className="h-12 bg-gray-200 rounded-xl" />
            <div className="h-12 bg-gray-200 rounded-full" />
          </div>
        </div>
      </div>
    </div>
  );
}
